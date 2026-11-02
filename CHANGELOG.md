# Changelog

## 1.0.0

首个正式版本。

**效果**

- 会话页右侧的跳转锚点（turn rail）随系统正在播放的声音律动，12 段对数频谱（45 Hz – 16 kHz），低频在底部。
- 只改几何：每根锚点是宿主原本的 2px 短条，插件只驱动它的 `scaleX`；颜色、发光、宿主的悬停/预览/当前状态都不覆盖。
- 四种状态共用同一段脉冲幅度（各 0.5，约 10px），当前高亮的锚点不会再因为贴着长度上限而显得呆滞；状态区分交给宿主的颜色。
- 33 ms 一帧，attack/release 平滑；`prefers-reduced-motion` 时整体停用。

**兼容性**

- macOS 14.2 及以上（Core Audio Process Tap），采集器为 arm64 + x86_64 通用二进制。
- 适配 `dsh-client-ui-chat` 的虚拟化 turn rail（属性选择器跨 CSS Modules hash，宿主升级不炸）。

**进程与权限**

- 采集器按需启动：只有页面订阅时才运行，最后一个订阅断开 15 秒后退出。
- 宿主退出（含崩溃）时 stdin 管道关闭，采集器读到 EOF 立即退出，不会留下占用系统音频的孤儿进程。
- 默认输出设备切换（耳机 / 蓝牙）时自动重建 tap。
- 未授权「系统音频录制」时以 `exit 2` 退出并在 `/audio-rail/status` 报 `permission-denied`，不再无限重启；授权后刷新页面即可恢复。
- 连续重启 10 次仍失败则放弃并上报，不空转。

**路由**

- `GET /audio-rail/events`：SSE，`event: frame`，15 秒心跳。
- `GET /audio-rail/status`：JSON 快照，便于 `curl` 自检。
- 两条路由都只接受 loopback。
