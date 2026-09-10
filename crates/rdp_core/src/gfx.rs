//! RDPEGFX AVC420 软件解码、表面生命周期及有界诊断统计。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ironrdp_egfx::client::{BitmapUpdate, GraphicsPipelineClient, GraphicsPipelineHandler};
use ironrdp_egfx::decode::{DecodedFrame, DecoderError, DecoderResult, H264Decoder};
use ironrdp_egfx::pdu::{CapabilitiesV81Flags, CapabilitySet};
use openh264::decoder::Decoder;
use openh264::formats::YUVSource;

/// 限制并行预测帧上下文，异常服务器不能无限创建解码器。
const MAX_DECODER_SURFACES: usize = 8;
const MAX_DECODED_PIXELS: usize = 4096 * 4096;

/// 诊断计数为每会话累计值，窗口差分由测试采集端计算。
#[derive(Debug, Default, Clone)]
pub(crate) struct GfxSnapshot {
    pub negotiated: bool,
    pub avc420_negotiated: bool,
    pub reset_generation: u64,
    pub avc420_frames: u64,
    pub avc420_bytes: u64,
    pub decode_us: u64,
    pub rgba_conversion_us: u64,
    pub decoded_pixels: u64,
    pub bitmap_updates: u64,
}

/// 解码器和会话共享固定大小的统计，不缓存图形或事件。
#[derive(Debug, Default, Clone)]
pub(crate) struct GfxDiagnostics(Arc<Mutex<GfxSnapshot>>);

impl GfxDiagnostics {
    /// 读取当前统计快照。
    pub fn snapshot(&self) -> GfxSnapshot {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// 协商仅声明已实现的 AVC420，具体编码仍由服务器选择。
struct GfxHandler(GfxDiagnostics);

impl GraphicsPipelineHandler for GfxHandler {
    fn on_capabilities_confirmed(&mut self, caps: &CapabilitySet) {
        let mut stats = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        stats.negotiated = true;
        stats.avc420_negotiated = matches!(caps, CapabilitySet::V8_1 { flags }
            if flags.contains(CapabilitiesV81Flags::AVC420_ENABLED));
    }

    fn on_reset_graphics(&mut self, _width: u32, _height: u32) {
        let mut stats = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        stats.reset_generation = stats.reset_generation.saturating_add(1);
    }

    fn on_bitmap_updated(&mut self, _update: &BitmapUpdate) {
        let mut stats = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        stats.bitmap_updates += 1;
    }
}

/// 每个 surfaceId 独立保存 H.264 参考帧，避免多表面交替更新串流。
struct Avc420Decoder {
    surfaces: BTreeMap<u16, Decoder>,
    diagnostics: GfxDiagnostics,
}

impl H264Decoder for Avc420Decoder {
    fn decode(&mut self, data: &[u8]) -> DecoderResult<DecodedFrame> {
        self.decode_surface(0, data)
    }

    fn decode_surface(&mut self, surface_id: u16, data: &[u8]) -> DecoderResult<DecodedFrame> {
        // MS-RDPEGFX 2.2.4.4 使用 Annex B，不能按 AVCC 长度前缀再次转换。
        if !data.starts_with(&[0, 0, 1]) && !data.starts_with(&[0, 0, 0, 1]) {
            return Err(DecoderError::msg("AVC420 requires Annex B start codes"));
        }
        if !self.surfaces.contains_key(&surface_id) {
            if self.surfaces.len() >= MAX_DECODER_SURFACES {
                return Err(DecoderError::msg("AVC420 decoder surface budget exceeded"));
            }
            self.surfaces.insert(
                surface_id,
                Decoder::new().map_err(|e| DecoderError::new("create OpenH264 decoder", e))?,
            );
        }
        let started = Instant::now();
        let decoder = self
            .surfaces
            .get_mut(&surface_id)
            .expect("decoder inserted");
        let yuv = decoder
            .decode(data)
            .map_err(|e| DecoderError::new("decode AVC420 Annex B", e))?
            .ok_or_else(|| DecoderError::msg("AVC420 access unit produced no picture"))?;
        let decode_us = started.elapsed().as_micros() as u64;
        let (width, height) = yuv.dimensions();
        let pixels = width
            .checked_mul(height)
            .filter(|n| *n > 0 && *n <= MAX_DECODED_PIXELS)
            .ok_or_else(|| DecoderError::msg("AVC420 decoded pixel budget exceeded"))?;
        let started = Instant::now();
        let mut rgba = vec![0; pixels * 4];
        yuv.write_rgba8(&mut rgba);
        let conversion_us = started.elapsed().as_micros() as u64;
        let mut stats = self.diagnostics.0.lock().unwrap_or_else(|e| e.into_inner());
        stats.avc420_frames += 1;
        stats.avc420_bytes += data.len() as u64;
        stats.decode_us += decode_us;
        stats.rgba_conversion_us += conversion_us;
        stats.decoded_pixels += pixels as u64;
        Ok(DecodedFrame::new(rgba, width as u32, height as u32))
    }

    fn delete_surface(&mut self, surface_id: u16) {
        self.surfaces.remove(&surface_id);
    }

    fn reset(&mut self) {
        self.surfaces.clear();
    }
}

/// 创建图形通道及其诊断句柄，保持每条连接独立。
pub(crate) fn create_graphics_pipeline() -> (GraphicsPipelineClient, GfxDiagnostics) {
    let diagnostics = GfxDiagnostics::default();
    let decoder = Avc420Decoder {
        surfaces: BTreeMap::new(),
        diagnostics: diagnostics.clone(),
    };
    let client = GraphicsPipelineClient::new(
        Box::new(GfxHandler(diagnostics.clone())),
        Some(Box::new(decoder)),
    );
    (client, diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::core::encode_vec;
    use ironrdp::dvc::DvcProcessor;
    use ironrdp::pdu::geometry::ExclusiveRectangle;
    use ironrdp_egfx::pdu::*;
    use openh264::encoder::Encoder;
    use openh264::formats::{RgbSliceU8, YUVBuffer};

    /// 使用运行时同一依赖验证 Progressive 升级，不把末尾有效零字节当填充删除。
    #[test]
    fn progressive_upgrade_accepts_length_delimited_component() {
        use ironrdp::graphics::progressive::{
            COEFFICIENTS_PER_COMPONENT, SIGN_POSITIVE, SIGN_ZERO, decode_upgrade_pass,
        };
        use ironrdp::pdu::codecs::rfx::progressive::ComponentCodecQuant;
        let mut previous = ComponentCodecQuant::LOSSLESS;
        previous.hl1 = 3;
        let mut coefficients = [0; COEFFICIENTS_PER_COMPONENT];
        let mut signs = [SIGN_POSITIVE; COEFFICIENTS_PER_COMPONENT];
        signs[0] = SIGN_ZERO;
        decode_upgrade_pass(
            &[0xa0, 0],
            &[0; 384],
            &previous,
            &ComponentCodecQuant::LOSSLESS,
            false,
            &mut coefficients,
            &mut signs,
        )
        .unwrap();
        assert_eq!(coefficients[0], -7);
        assert!(coefficients[1..].iter().all(|&value| value == 0));
        assert_eq!(signs[0], -1);
    }

    /// 编码确定性双色图，验证实际码流及非零原点区域。
    fn encode_picture(encoder: &mut Encoder, bright: bool) -> Vec<u8> {
        let mut rgb = vec![0; 32 * 32 * 3];
        for y in 0..32 {
            for x in 0..32 {
                let value = if (x >= 16) == bright { 220 } else { 20 };
                rgb[(y * 32 + x) * 3..(y * 32 + x + 1) * 3].fill(value);
            }
        }
        encoder
            .encode(&YUVBuffer::from_rgb_source(RgbSliceU8::new(&rgb, (32, 32))))
            .unwrap()
            .to_vec()
    }

    /// 通过真实 GFX PDU 和无压缩 ZGFX 封装调用通道处理器。
    fn send(
        client: &mut GraphicsPipelineClient,
        pdu: GfxPdu,
    ) -> ironrdp::pdu::PduResult<Vec<ironrdp::dvc::DvcMessage>> {
        let mut wire = vec![0xe0, 0x04];
        wire.extend(encode_vec(&pdu).unwrap());
        client.process(1, &wire)
    }

    fn rect(left: u16, top: u16, right: u16, bottom: u16) -> ExclusiveRectangle {
        ExclusiveRectangle {
            left,
            top,
            right,
            bottom,
        }
    }

    fn reset(client: &mut GraphicsPipelineClient, width: u32) {
        send(
            client,
            GfxPdu::ResetGraphics(ResetGraphicsPdu {
                width,
                height: 32,
                monitors: vec![],
            }),
        )
        .unwrap();
        send(
            client,
            GfxPdu::CreateSurface(CreateSurfacePdu {
                surface_id: 1,
                width: 32,
                height: 32,
                pixel_format: PixelFormat::XRgb,
            }),
        )
        .unwrap();
        send(
            client,
            GfxPdu::MapSurfaceToOutput(MapSurfaceToOutputPdu {
                surface_id: 1,
                output_origin_x: 0,
                output_origin_y: 0,
            }),
        )
        .unwrap();
    }

    fn update(data: &[u8], regions: Vec<ExclusiveRectangle>) -> GfxPdu {
        let meta = Avc420BitmapStream {
            quant_qual_vals: regions
                .iter()
                .map(|_| QuantQuality {
                    quantization_parameter: 0,
                    progressive: false,
                    quality: 100,
                })
                .collect(),
            rectangles: regions,
            data,
        };
        GfxPdu::WireToSurface1(WireToSurface1Pdu {
            surface_id: 1,
            codec_id: Codec1Type::Avc420,
            pixel_format: PixelFormat::XRgb,
            destination_rectangle: rect(0, 0, 32, 32),
            bitmap_data: encode_vec(&meta).unwrap(),
        })
    }

    #[test]
    fn capability_sets_enable_only_implemented_avc() {
        let caps = GfxHandler(GfxDiagnostics::default()).capabilities();
        assert!(
            caps.iter()
                .any(|cap| matches!(cap, CapabilitySet::V8_1 { flags }
            if flags.contains(CapabilitiesV81Flags::AVC420_ENABLED)))
        );
        assert!(
            caps.iter()
                .all(|cap| matches!(cap, CapabilitySet::V8 { .. } | CapabilitySet::V8_1 { .. }))
        );
    }

    #[test]
    fn annex_b_decoding_keeps_independent_surface_references() {
        let mut first = Encoder::new().unwrap();
        let mut second = Encoder::new().unwrap();
        let mut decoder = Avc420Decoder {
            surfaces: BTreeMap::new(),
            diagnostics: GfxDiagnostics::default(),
        };
        for _ in 0..3 {
            let a = decoder
                .decode_surface(1, &encode_picture(&mut first, true))
                .unwrap();
            let b = decoder
                .decode_surface(2, &encode_picture(&mut second, false))
                .unwrap();
            assert!(a.data()[0] < 60);
            assert!(b.data()[0] > 180);
        }
        assert_eq!(decoder.surfaces.len(), 2);
        decoder.delete_surface(1);
        assert!(!decoder.surfaces.contains_key(&1));
        decoder.reset();
        assert!(decoder.surfaces.is_empty());
        assert!(decoder.decode(&[0, 0, 0, 2, 0x65, 0]).is_err());
    }

    #[test]
    fn avc420_masks_preserve_pixels_outside_region_and_reset_recovers() {
        let (mut client, diagnostics) = create_graphics_pipeline();
        send(
            &mut client,
            GfxPdu::CapabilitiesConfirm(CapabilitiesConfirmPdu::from_typed(&CapabilitySet::V8_1 {
                flags: CapabilitiesV81Flags::AVC420_ENABLED,
            })),
        )
        .unwrap();
        reset(&mut client, 32);
        assert_eq!(client.take_output_reset(), Some((32, 32)));
        let mut encoder = Encoder::new().unwrap();
        send(
            &mut client,
            update(
                &encode_picture(&mut encoder, true),
                vec![rect(16, 4, 30, 28)],
            ),
        )
        .unwrap();
        let ack = send(&mut client, GfxPdu::EndFrame(EndFramePdu { frame_id: 1 })).unwrap();
        assert!(!ack.is_empty());
        let output = client.drain_output();
        assert!(!output.is_empty());
        // 初次映射可能产生完整表面更新；所有更新都从权威表面读取。
        for output in &output {
            for y in output.region.top..output.region.bottom {
                for x in output.region.left..output.region.right {
                    let offset = (usize::from(y - output.region.top)
                        * usize::from(output.region.right - output.region.left)
                        + usize::from(x - output.region.left))
                        * 4;
                    if (16..30).contains(&x) && (4..28).contains(&y) {
                        assert!(output.data[offset] > 180);
                    } else {
                        assert_eq!(output.data[offset], 0);
                    }
                }
            }
        }
        assert!(client.drain_output().is_empty());
        reset(&mut client, 64);
        assert_eq!(client.take_output_reset(), Some((64, 32)));
        let mut encoder = Encoder::new().unwrap();
        send(
            &mut client,
            update(
                &encode_picture(&mut encoder, false),
                vec![rect(0, 0, 32, 32)],
            ),
        )
        .unwrap();
        send(&mut client, GfxPdu::EndFrame(EndFramePdu { frame_id: 2 })).unwrap();
        assert!(client.drain_output()[0].data[0] > 180);
        let stats = diagnostics.snapshot();
        assert!(stats.negotiated && stats.avc420_negotiated);
        assert_eq!(stats.avc420_frames, 2);
        assert_eq!(stats.reset_generation, 2);
    }

    #[test]
    fn malformed_region_is_rejected_without_partial_composition() {
        let (mut client, _) = create_graphics_pipeline();
        reset(&mut client, 32);
        send(&mut client, GfxPdu::EndFrame(EndFramePdu { frame_id: 0 })).unwrap();
        let _ = client.drain_output();
        let data = encode_picture(&mut Encoder::new().unwrap(), true);
        assert!(
            send(
                &mut client,
                update(&data, vec![rect(0, 0, 8, 8), rect(30, 0, 40, 10)])
            )
            .is_err()
        );
        send(&mut client, GfxPdu::EndFrame(EndFramePdu { frame_id: 1 })).unwrap();
        assert!(client.drain_output().is_empty());
    }
}
