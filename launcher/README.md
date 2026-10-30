# Chestnut Launcher

独立实现的最小桌面客户端（不 fork 通用开源 launcher）。分层结构：

- `core/`：平台无关 Swift 包——消息模型、`ChatReducer` 状态机、`WireDecoder`（`chestnut.launcher.v2` envelope 解码）、`SendClient`/`StreamClient` capability、失败恢复。不依赖 SwiftUI/AppKit/Process。
- `macos/`：macOS 外壳——accessory `NSPanel` 浮窗（不进 Dock/Cmd-Tab、失焦隐藏）、Carbon 全局 `⌥Space` 切换显示/隐藏、`Esc` 本地隐藏、SwiftUI `ChatView`、`MacOSChestnutProcess`（`Process` 子进程）。Windows/Linux 未来各自实现外壳、复用 core。

## 开发构建与覆盖

需要 macOS 13+ 与 Swift 5.8+ 工具链。无完整 Xcode、SwiftPM 因 CLT `PlatformPath` 不可用时，可直接构建（在仓库根目录执行）：

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

先运行 `pnpm build` 生成仓库的 `dist/cli.js`。裸可执行的开发覆盖均为显式 opt-in：

- `CHESTNUT_CLI_JS`：开发用 `dist/cli.js` 路径；裸可执行通常需要它，app 未设置时使用随包 CLI。
- `CHESTNUT_NODE`：开发用 Node 可执行文件路径；app 未设置时使用随包 Node，不回退系统 Node。
- `CHESTNUT_ROOT`：开发/测试工作区父目录（其下为 `.chestnut`）。**不再是必需项**；未设置时使用 `~/Library/Application Support/Chestnut`。

例如使用开发 CLI 和默认用户 root：

```bash
CHESTNUT_CLI_JS=/path/to/chestnut/dist/cli.js \
CHESTNUT_NODE=/path/to/node \
./.build/chestnut-launcher
```

## 生成 macOS app

在仓库根目录运行：

```bash
bash launcher/macos/Scripts/package-app.sh --output /tmp/chestnut-app
```

产物为 `/tmp/chestnut-app/Chestnut Launcher.app`。默认输出目录是 `launcher/macos/.build/app`。脚本不依赖调用时的 cwd，并且每次先执行 `pnpm build`，避免复制陈旧 dist。可选参数：

- `--node PATH`：指定要随包复制的 Node；默认 `command -v node`。
- `--launcher PATH`：使用既有 launcher 可执行文件，主要供轻量测试 fixture 使用；省略时按上述直接 `swiftc` 路径构建，并随包复制 core dylib。
- `--output DIR`：指定 app 的父目录；完整构建和验证通过后才替换已有 app。

关键布局：

```text
Chestnut Launcher.app/Contents/
├── Info.plist
├── MacOS/
│   ├── chestnut-launcher
│   └── core/libLauncherCore.dylib   # 直接 swiftc 构建时
└── Resources/
    ├── build-metadata.json
    ├── chestnut-cli/
    │   ├── package.json
    │   ├── dist/                    # 完整 pnpm build 产物
    │   └── node_modules/            # lockfile 对应的 production 依赖闭包
    └── node/bin/node
```

`build-metadata.json` 记录 CLI/Node 版本、Node 架构、可得时的 source revision 和 UTC 生成时间，不依赖 `jq`。由于 tsup 保留外部 package imports，脚本还在隔离目录用同一 lockfile 和本地 pnpm store 离线安装 production-only `node_modules`；只复制 `dist` 并不足以运行。本步不签名、不 notarize，也不安装到系统目录。

## 无开发 env 运行与安装后 smoke

打包 app 直接使用 `Contents/Resources` 内的 Node 和 CLI；无需设置 `CHESTNUT_CLI_JS`、`CHESTNUT_NODE` 或 `CHESTNUT_ROOT`。双击、`open '/tmp/chestnut-app/Chestnut Launcher.app'` 均可，用户状态默认写入 `~/Library/Application Support/Chestnut/.chestnut`，不会写入 app 资源目录。

```bash
bash launcher/macos/Scripts/smoke-installed-app.sh \
  '/tmp/chestnut-app/Chestnut Launcher.app'
```

smoke 逐项检查 launcher、Node、完整 CLI 入口和元数据；用 `env -i` 清除开发覆盖并提供不含系统 Node 的 PATH。所有 HOME、cwd、TMPDIR 和默认 root 都在 `mktemp` 临时目录中，直接调用随包 Node + CLI 验证单行 `launcher status --json` snapshot 和 root，再把 app 复制到含空格的路径重复布局/CLI 检查，并断言 app 内无 `.chestnut`。缺少 Node/CLI fixture、协议输出异常或资源不可执行都会失败；不会读取或修改真实用户 HOME 数据。

smoke 不伪造 GUI 或凭据结果：真实 GUI 启动以及 `start/send/stream` 的 macOS/供应商凭据验证仍为 **pending**，需另行执行。

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
