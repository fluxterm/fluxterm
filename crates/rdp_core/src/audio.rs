//! RDP 远端音频的本地播放后端。
//!
//! 本模块只处理 IronRDP `rdpsnd` 已完成协商后的 PCM 数据、本地静音和
//! CPAL 资源生命周期；协议状态机继续由 IronRDP 维护。

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use cpal::{SampleFormat, Stream, StreamConfig};
use ironrdp::rdpsnd::client::RdpsndClientHandler;
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};
use serde_json::json;
use tokio::sync::mpsc;

use crate::protocol::RuntimeAudioState;
use crate::telemetry::{TelemetryLevel, log_telemetry};

const PCM_CHANNELS: u16 = 2;
const PCM_SAMPLE_RATE: u32 = 44_100;
const PCM_BITS_PER_SAMPLE: u16 = 16;
const MAX_BUFFER_SECONDS: usize = 2;
const AUDIO_IDLE_TIMEOUT: Duration = Duration::from_millis(750);
const AUDIO_ACTIVITY_POLL_INTERVAL: Duration = Duration::from_millis(100);

static PCM_AUDIO_FORMATS: LazyLock<Vec<AudioFormat>> = LazyLock::new(|| {
    let block_align = PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);
    vec![AudioFormat {
        format: WaveFormat::PCM,
        n_channels: PCM_CHANNELS,
        n_samples_per_sec: PCM_SAMPLE_RATE,
        n_avg_bytes_per_sec: PCM_SAMPLE_RATE * u32::from(block_align),
        n_block_align: block_align,
        bits_per_sample: PCM_BITS_PER_SAMPLE,
        data: None,
    }]
});

/// 音频播放线程向 RDP 主循环发送的状态事件。
#[derive(Debug, Clone)]
pub enum AudioProxyEvent {
    /// 本地播放状态发生变化。
    StateChanged {
        /// 最新音频状态。
        state: RuntimeAudioState,
        /// 可选的人类可读错误信息。
        message: Option<String>,
    },
}

/// 允许会话控制面更新静音状态的轻量控制器。
#[derive(Debug, Clone)]
pub struct AudioPlaybackController {
    shared: Arc<AudioShared>,
}

impl AudioPlaybackController {
    /// 创建控制器和对应的 IronRDP 播放后端。
    pub fn new(session_id: String, proxy_tx: mpsc::UnboundedSender<AudioProxyEvent>) -> Self {
        Self {
            shared: Arc::new(AudioShared {
                session_id,
                muted: AtomicBool::new(false),
                wave_sequence: AtomicU64::new(0),
                stream_failed: AtomicBool::new(false),
                proxy_tx,
            }),
        }
    }

    /// 创建交给 `rdpsnd` 状态机持有的本地播放后端。
    pub fn create_backend(&self) -> FluxRdpsndBackend {
        FluxRdpsndBackend::new(Arc::clone(&self.shared))
    }

    /// 更新会话静音状态。
    pub fn set_muted(&self, muted: bool) {
        self.shared.muted.store(muted, Ordering::Relaxed);
    }
}

#[derive(Debug)]
struct AudioShared {
    session_id: String,
    muted: AtomicBool,
    wave_sequence: AtomicU64,
    stream_failed: AtomicBool,
    proxy_tx: mpsc::UnboundedSender<AudioProxyEvent>,
}

impl AudioShared {
    fn publish_state(&self, state: RuntimeAudioState, message: Option<String>) {
        let _ = self
            .proxy_tx
            .send(AudioProxyEvent::StateChanged { state, message });
    }
}

/// FluxTerm 的 IronRDP PCM 播放实现。
#[derive(Debug)]
pub struct FluxRdpsndBackend {
    shared: Arc<AudioShared>,
    stream_handle: Option<JoinHandle<()>>,
    stream_ended: Arc<AtomicBool>,
    pcm_buffer: Arc<Mutex<PcmBuffer>>,
    format_no: Option<usize>,
}

impl FluxRdpsndBackend {
    fn new(shared: Arc<AudioShared>) -> Self {
        Self {
            shared,
            stream_handle: None,
            stream_ended: Arc::new(AtomicBool::new(false)),
            pcm_buffer: Arc::new(Mutex::new(PcmBuffer::new(max_buffer_bytes()))),
            format_no: None,
        }
    }

    fn ensure_stream(&mut self, format_no: usize) {
        if self.format_no != Some(format_no) {
            self.close();
        }
        if self.stream_handle.is_some() {
            return;
        }

        let Some(format) = self.get_formats().get(format_no).cloned() else {
            let message = format!("unsupported negotiated audio format index: {format_no}");
            self.shared
                .publish_state(RuntimeAudioState::Error, Some(message.clone()));
            log_telemetry(
                TelemetryLevel::Error,
                "rdp.audio.format.invalid",
                json!({
                    "sessionId": &self.shared.session_id,
                    "formatNo": format_no,
                    "error": { "code": "rdp_audio_format_invalid", "message": message },
                }),
            );
            return;
        };

        self.format_no = Some(format_no);
        self.stream_ended.store(false, Ordering::Relaxed);
        self.shared.stream_failed.store(false, Ordering::Relaxed);
        let shared = Arc::clone(&self.shared);
        let stream_ended = Arc::clone(&self.stream_ended);
        let pcm_buffer = Arc::clone(&self.pcm_buffer);
        log_telemetry(
            TelemetryLevel::Info,
            "rdp.audio.format.selected",
            json!({
                "sessionId": &shared.session_id,
                "formatNo": format_no,
                "channels": format.n_channels,
                "sampleRate": format.n_samples_per_sec,
                "bitsPerSample": format.bits_per_sample,
            }),
        );

        self.stream_handle = Some(thread::spawn(move || {
            let stream = match build_output_stream(&format, pcm_buffer, Arc::clone(&shared)) {
                Ok(stream) => stream,
                Err(error) => {
                    shared.stream_failed.store(true, Ordering::Relaxed);
                    log_telemetry(
                        TelemetryLevel::Error,
                        "rdp.audio.playback.failed",
                        json!({
                            "sessionId": &shared.session_id,
                            "error": { "code": "rdp_audio_playback_failed", "message": &error },
                        }),
                    );
                    shared.publish_state(RuntimeAudioState::Error, Some(error));
                    return;
                }
            };
            if let Err(error) = stream.play() {
                shared.stream_failed.store(true, Ordering::Relaxed);
                let message = format!("failed to start audio output stream: {error}");
                shared.publish_state(RuntimeAudioState::Error, Some(message.clone()));
                log_telemetry(
                    TelemetryLevel::Error,
                    "rdp.audio.playback.failed",
                    json!({
                        "sessionId": &shared.session_id,
                        "error": { "code": "rdp_audio_playback_start_failed", "message": message },
                    }),
                );
                return;
            }

            shared.publish_state(RuntimeAudioState::Playing, None);
            log_telemetry(
                TelemetryLevel::Info,
                "rdp.audio.playback.started",
                json!({ "sessionId": &shared.session_id }),
            );

            let mut activity = AudioActivityTracker::new(
                shared.wave_sequence.load(Ordering::Relaxed),
                Instant::now(),
            );
            while !stream_ended.load(Ordering::Relaxed) {
                thread::park_timeout(AUDIO_ACTIVITY_POLL_INTERVAL);
                if shared.stream_failed.load(Ordering::Relaxed) {
                    continue;
                }
                if let Some(state) =
                    activity.update(shared.wave_sequence.load(Ordering::Relaxed), Instant::now())
                {
                    shared.publish_state(state, None);
                }
            }
            drop(stream);
            log_telemetry(
                TelemetryLevel::Info,
                "rdp.audio.playback.closed",
                json!({ "sessionId": &shared.session_id }),
            );
        }));
    }
}

impl Drop for FluxRdpsndBackend {
    fn drop(&mut self) {
        self.close();
    }
}

impl RdpsndClientHandler for FluxRdpsndBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        PCM_AUDIO_FORMATS.as_slice()
    }

    fn wave(&mut self, format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        self.shared.wave_sequence.fetch_add(1, Ordering::Relaxed);
        self.ensure_stream(format_no);
        if let Ok(mut buffer) = self.pcm_buffer.lock() {
            buffer.push(data.as_ref());
        }
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {
        self.format_no = None;
        if let Ok(mut buffer) = self.pcm_buffer.lock() {
            buffer.clear();
        }
        if let Some(stream_handle) = self.stream_handle.take() {
            self.stream_ended.store(true, Ordering::Relaxed);
            stream_handle.thread().unpark();
            if stream_handle.join().is_err() {
                log_telemetry(
                    TelemetryLevel::Warn,
                    "rdp.audio.playback.join.failed",
                    json!({ "sessionId": &self.shared.session_id }),
                );
            }
        }
        self.shared.publish_state(RuntimeAudioState::Idle, None);
    }
}

/// 根据音频包序号和静默时间生成播放活动状态转换。
#[derive(Debug)]
struct AudioActivityTracker {
    last_wave_sequence: u64,
    last_wave_at: Instant,
    playing: bool,
}

impl AudioActivityTracker {
    fn new(wave_sequence: u64, now: Instant) -> Self {
        Self {
            last_wave_sequence: wave_sequence,
            last_wave_at: now,
            playing: true,
        }
    }

    fn update(&mut self, wave_sequence: u64, now: Instant) -> Option<RuntimeAudioState> {
        if wave_sequence != self.last_wave_sequence {
            self.last_wave_sequence = wave_sequence;
            self.last_wave_at = now;
            if !self.playing {
                self.playing = true;
                return Some(RuntimeAudioState::Playing);
            }
            return None;
        }

        if self.playing && now.duration_since(self.last_wave_at) >= AUDIO_IDLE_TIMEOUT {
            self.playing = false;
            return Some(RuntimeAudioState::Idle);
        }

        None
    }
}

fn build_output_stream(
    format: &AudioFormat,
    pcm_buffer: Arc<Mutex<PcmBuffer>>,
    shared: Arc<AudioShared>,
) -> Result<Stream, String> {
    if format.format != WaveFormat::PCM
        || format.bits_per_sample != PCM_BITS_PER_SAMPLE
        || format.n_channels != PCM_CHANNELS
        || format.n_samples_per_sec != PCM_SAMPLE_RATE
    {
        return Err("negotiated audio format is not supported".to_string());
    }

    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| "no default audio output device".to_string())?;
    let config = StreamConfig {
        channels: format.n_channels,
        sample_rate: format.n_samples_per_sec,
        buffer_size: cpal::BufferSize::Default,
    };
    let error_shared = Arc::clone(&shared);
    device
        .build_output_stream_raw(
            &config,
            SampleFormat::I16,
            move |data, _| {
                let output = data.bytes_mut();
                if let Ok(mut buffer) = pcm_buffer.lock() {
                    buffer.fill(output, shared.muted.load(Ordering::Relaxed));
                } else {
                    output.fill(0);
                }
            },
            move |error| {
                error_shared.stream_failed.store(true, Ordering::Relaxed);
                let message = format!("audio output stream error: {error}");
                error_shared.publish_state(RuntimeAudioState::Error, Some(message.clone()));
                log_telemetry(
                    TelemetryLevel::Error,
                    "rdp.audio.playback.stream.error",
                    json!({
                        "sessionId": &error_shared.session_id,
                        "error": { "code": "rdp_audio_stream_error", "message": message },
                    }),
                );
            },
            None,
        )
        .map_err(|error| format!("failed to create audio output stream: {error}"))
}

fn max_buffer_bytes() -> usize {
    PCM_SAMPLE_RATE as usize
        * PCM_CHANNELS as usize
        * (PCM_BITS_PER_SAMPLE as usize / 8)
        * MAX_BUFFER_SECONDS
}

#[derive(Debug)]
struct PcmBuffer {
    bytes: VecDeque<u8>,
    max_bytes: usize,
}

impl PcmBuffer {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(max_bytes),
            max_bytes,
        }
    }

    fn push(&mut self, data: &[u8]) {
        let overflow = self
            .bytes
            .len()
            .saturating_add(data.len())
            .saturating_sub(self.max_bytes);
        self.bytes.drain(..overflow.min(self.bytes.len()));
        self.bytes.extend(data.iter().copied());
    }

    fn fill(&mut self, output: &mut [u8], muted: bool) {
        if muted {
            self.clear();
            output.fill(0);
            return;
        }
        for byte in output {
            *byte = self.bytes.pop_front().unwrap_or(0);
        }
    }

    fn clear(&mut self) {
        self.bytes.clear();
    }
}

#[cfg(test)]
mod tests {
    use ironrdp::rdpsnd::client::RdpsndClientHandler as _;
    use tokio::sync::mpsc;

    use std::time::{Duration, Instant};

    use super::{
        AUDIO_IDLE_TIMEOUT, AudioActivityTracker, AudioPlaybackController, AudioProxyEvent,
        PCM_AUDIO_FORMATS, PcmBuffer,
    };
    use crate::protocol::RuntimeAudioState;

    #[test]
    fn advertises_only_supported_pcm_format() {
        let format = &PCM_AUDIO_FORMATS[0];
        assert_eq!(format.n_channels, 2);
        assert_eq!(format.n_samples_per_sec, 44_100);
        assert_eq!(format.bits_per_sample, 16);
    }

    #[test]
    fn mute_clears_buffer_and_outputs_silence() {
        let mut buffer = PcmBuffer::new(16);
        buffer.push(&[1, 2, 3, 4]);
        let mut output = [9; 4];
        buffer.fill(&mut output, true);
        assert_eq!(output, [0; 4]);
        assert!(buffer.bytes.is_empty());
    }

    #[test]
    fn buffer_drops_oldest_audio_when_capacity_is_exceeded() {
        let mut buffer = PcmBuffer::new(4);
        buffer.push(&[1, 2, 3]);
        buffer.push(&[4, 5, 6]);
        let mut output = [0; 4];
        buffer.fill(&mut output, false);
        assert_eq!(output, [3, 4, 5, 6]);
    }

    #[test]
    fn closing_backend_repeatedly_is_idempotent() {
        let (proxy_tx, mut proxy_rx) = mpsc::unbounded_channel();
        let controller = AudioPlaybackController::new("test-session".to_string(), proxy_tx);
        let mut backend = controller.create_backend();

        backend.close();
        backend.close();

        for _ in 0..2 {
            let event = proxy_rx
                .try_recv()
                .expect("close should publish idle state");
            assert!(matches!(
                event,
                AudioProxyEvent::StateChanged {
                    state: RuntimeAudioState::Idle,
                    message: None,
                }
            ));
        }
    }

    #[test]
    fn audio_activity_becomes_idle_after_wave_timeout_and_resumes() {
        let started_at = Instant::now();
        let mut activity = AudioActivityTracker::new(1, started_at);

        assert_eq!(
            activity.update(1, started_at + AUDIO_IDLE_TIMEOUT),
            Some(RuntimeAudioState::Idle)
        );
        assert_eq!(
            activity.update(
                2,
                started_at + AUDIO_IDLE_TIMEOUT + Duration::from_millis(1)
            ),
            Some(RuntimeAudioState::Playing)
        );
        assert_eq!(
            activity.update(
                3,
                started_at + AUDIO_IDLE_TIMEOUT + Duration::from_millis(2)
            ),
            None
        );
    }
}
