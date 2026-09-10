# IronRDP 本地补丁

这四个包复制自 [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP/tree/f6391452da15cd7cf9896f095b0df2909593ccc0) 的固定提交 `f6391452da15cd7cf9896f095b0df2909593ccc0`，各包保留上游 README 和 MIT / Apache-2.0 许可证。其他 IronRDP 包直接使用同一 Git 提交。根目录的 Cargo patch 使传递依赖与直接依赖共用这些包。

本地差异：

- Cargo 清单展开上游 workspace 元数据，内部依赖固定到同一个 Git 提交；独立 workspace 防止第三方包混入产品成员。
- `ironrdp-connector`：延续原 `fluxterm/IronRDP` 提交 `de984958117296644576b5306a2ebc09a80a6941` 的 picky `rc.26` 兼容修复，根清单继续保留 sspi / picky 补丁。
- `ironrdp-egfx`：AVC420 使用 Annex B；按 `regionRects` 的表面坐标拷贝；解码接口传递 surfaceId 并通知表面删除；提供待消费的 ResetGraphics 尺寸。
- `ironrdp-graphics`：SRL 按字段长度读取，不强制或提前剥离末尾零字节；零游程逐块消费，允许在目标系数边界结束，保留跨子带状态和真正截断时的错误。矩形并集按闭区间像素分带，保留单行、单列和带间区域，避免 Progressive 瓦片裁剪漏更新；使用 u32 中间边界避免最大坐标溢出。
- `ironrdp-session`：合成前消费图形尺寸重置，包含同尺寸重置；保留稀疏输出区域，交由 FluxTerm 现有面积约束策略合并。输出画面限制为 16,777,216 像素。

FluxTerm 的 OpenH264 适配器位于 `crates/rdp_core/src/gfx.rs`，使用源码构建，最多保留 8 个表面解码上下文。超过预算显式结束错误会话。未声明 AVC444，未接入硬件解码。软件解码之后继续使用 RGBA 传输与本地纹理上传。

更新依赖时，必须同时更新所有 IronRDP Git 提交、四个本地包的内部依赖及本说明，并重新核查以上补丁是否已被上游包含。不要修改 Cargo 缓存代替仓库补丁。

在仓库根目录验证：

```powershell
cargo test --manifest-path vendor/ironrdp-graphics/Cargo.toml --target-dir target/graphics-tests --lib
cargo test -p ironrdp-egfx -p ironrdp-session --lib
cargo test -p fluxterm-rdp-core --lib --all-features
cargo clippy --all-targets --all-features -- -D warnings
```

协议依据：[AVC420 码流格式与区域掩码](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/5f12c20e-2ea1-4ad1-a2a0-019ee3893731)。OpenH264 源码包的授权信息随其 Cargo 依赖提供；软件源码构建与 Cisco 预编译二进制分发是不同的构建路线。

SRL 兼容依据：[FreeRDP 的 Progressive 解码及尾部处理](https://github.com/FreeRDP/FreeRDP/blob/master/libfreerdp/codec/progressive.c)，其 `progressive_rfx_upgrade_state_finish` 允许尾字节缺省。测试覆盖无尾字节、有效零尾字节、跨子带零游程及真正截断的码字。
