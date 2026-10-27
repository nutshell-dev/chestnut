# Chestnut Launcher

独立实现的最小桌面客户端（不 fork 通用开源 launcher）。分层结构：

- `core/`：平台无关 Swift 包——消息模型、`ChatReducer` 状态机、`WireDecoder`（`chestnut.launcher.v2` envelope 解码）、`SendClient`/`StreamClient` capability、失败恢复。不依赖 SwiftUI/AppKit/Process。
- `macos/`：macOS 外壳——accessory `NSPanel` 浮窗（不进 Dock/Cmd-Tab、失焦隐藏）、Carbon 全局 `⌥Space` 切换显示/隐藏、`Esc` 本地隐藏、SwiftUI `ChatView`（Spotlight 风格三态布局：compact 单行输入 → expanded 顶部 composer + 回复区 → capped 回复区内滚）、`MacOSChestnutProcess`（`Process` 子进程）。Windows/Linux 未来各自实现外壳、复用 core。

## 运行

无 Xcode 环境的直接构建（SwiftPM 需要完整 Xcode）：

```bash
cd launcher/macos
mkdir -p .build/core
swiftc -emit-library -emit-module -enable-testing -module-name LauncherCore \
  ../core/Sources/LauncherCore/*.swift \
  -o .build/core/libLauncherCore.dylib -emit-module-path .build/core/LauncherCore.swiftmodule \
  -Xlinker -install_name -Xlinker @rpath/libLauncherCore.dylib
swiftc -I .build/core -L .build/core -lLauncherCore Sources/LauncherMacOS/*.swift \
  -o .build/chestnut-launcher -Xlinker -rpath -Xlinker @executable_path/core
```

启动（`CHESTNUT_ROOT` 必需——CLI 按 `CHESTNUT_ROOT ?? cwd` 定位 `.chestnut/config.yaml`）：

```bash
CHESTNUT_CLI_JS=/path/to/chestnut/dist/cli.js \
CHESTNUT_ROOT=/path/to/chestnut \
./.build/chestnut-launcher
```

需要 macOS 13+ 与 Swift 5.8+ 工具链。先构建 chestnut（`pnpm build`）再指向其 `dist/cli.js`。

## 协议

CLI 交互走版本化 `chestnut.launcher.v2` envelope（`protocol`/`sequence`/`kind`/`payload`）：

- `launcher status --json`：一次性 snapshot，包含 initialization、setup、daemon 与 capabilities。
- `launcher setup --json`：沿用 `chestnut.launcher.setup.v1` 初始化协议，响应声明 v2 能力。
- `launcher start --json`：确保 watchdog/daemon/Motion ready 后退出，不进入 viewport。
- `launcher send --json`：从 stdin 接收 `{requestId,text}`，以 send_ack 返回 delivery 与 daemon；persisted 不表示 processing。
- `launcher stream --json --from-current-turn`：先发送 snapshot，再发送 daemon/activity/message/terminal；重连用 `--after-sequence` 获取 snapshot + `resync_required`。

## 与 chestnut 的边界

- 聊天事实、消息顺序、会话恢复、daemon 与凭据归 chestnut；launcher 只拥有窗口、输入框、时间线展示模型和未 ack 本地草稿。
- launcher 不读写 chestnut 文件（`stream.jsonl`、inbox、audit 等），不 import chestnut 源码，一切交互经 `launcher status|setup|start|send|stream` CLI。
- launcher 不自动启动/停止/监督 daemon，不重发没有 ack 的消息；断线只恢复订阅位置。

## 明确不支持（现阶段排除项）

slash 命令、自定义 hotkey、插件、应用搜索、剪贴板、菜单栏、Windows/Linux 外壳、签名/notarization 分发。全局 `⌥Space` 注册失败时记录错误并保留手动唤出、`Esc` 和失焦隐藏；隐藏窗口不停止 stream、不清空 draft。
