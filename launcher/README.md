# Chestnut Launcher（v0）

独立实现的最小桌面客户端（不 fork 通用开源 launcher）。分层结构：

- `launcher-core/`：平台无关 Swift package——消息模型、`ChatReducer` 状态机、`WireDecoder`（JSONL envelope 解码）、`SendClient`/`StreamClient` capability、失败恢复。不依赖 SwiftUI/AppKit/Process。
- `launcher-macos/`：macOS 外壳——SwiftUI `ChatView` + AppKit 标准 `NSWindow` + `MacOSChestnutProcess`（`Process` 子进程）。Windows/Linux 未来各自实现外壳、复用 core。

## 构建与测试

```bash
cd launcher-core && swift test        # core 状态机 / 协议 / 恢复测试
cd launcher-macos && swift build      # macOS 外壳构建
cd launcher-macos && swift test       # 外壳 adapter 与进程测试
```

## 运行

```bash
cd launcher-macos
CHESTNUT_CLI_JS=/path/to/chestnut/dist/cli.js swift run chestnut-launcher
# 可选：CHESTNUT_CLAW_NAME 指定 claw（默认 motion）
```

需要 macOS 13+ 与 Swift 5.8+ 工具链。先构建 chestnut（`pnpm build`）再指向其 `dist/cli.js`。

## 与 chestnut 的边界

- 聊天事实、消息顺序、会话恢复、daemon 与凭据归 chestnut；launcher 只拥有窗口、输入框、时间线展示模型和未 ack 本地草稿。
- launcher 不读写 chestnut 文件（`stream.jsonl`、inbox、audit 等），不 import chestnut 源码，一切交互经 `claw send` / `claw stream` CLI。
- ack 只确认 inbox 接收，不表示 Motion 已回复；Motion 回复只来自 stream event。
- launcher 不自动启动/停止/监督 daemon，不重发没有 ack 的消息；断线只恢复订阅位置。

## 协议现状（重要）

当前 `claw stream` 输出的是 chestnut 内部 `StreamEvent` JSONL，**尚无**版本化 launcher envelope（`protocolVersion`/`sequence`/`sessionId`）；`claw send` 也无机器可读 ack。因此：

- 对真实 CLI，stream 首行即 fail closed（protocolMismatch），send 以 exit 0 视为 inbox 已收并标注 ack 缺口；
- 缺口由 drift `CLI-PROTOCOL-LAUNCHER-EXTERNAL-WIRE` / `VIEWPORT-LAUNCHER-EVENT-BOUNDARY` 承载，待 chestnut code phase 治理；adapter 不伪造恢复成功。

## 明确不支持（v0 排除项）

slash 命令、全局 hotkey、插件、应用搜索、剪贴板、菜单栏、Windows/Linux 外壳、签名/notarization 分发。
