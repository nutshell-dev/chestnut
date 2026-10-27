import AppKit
import LauncherCore
import SwiftUI

/// @main 入口：AppKit 负责窗口生命周期，SwiftUI 负责视图。
/// accessory app（不进 Dock/Cmd-Tab）+ LauncherPanel 浮窗；窗口关闭/失焦只隐藏，
/// 不触碰 ChatStore 状态；应用退出统一停止 stream task。
@main
enum LauncherApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = LauncherAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(LauncherWindowPolicy.activation)
        app.run()
    }
}

/// CLI 装配：CHESTNUT_CLI_JS 指向 chestnut dist/cli.js；CHESTNUT_CLAW_NAME 默认 motion。
/// 未配置时返回本地失败的 client（degraded、不伪造连接成功）；不自动启动 daemon。
enum LauncherClientFactory {
    static func makeSendClient(environment: [String: String] = ProcessInfo.processInfo.environment) -> any SendClient {
        guard let argvPrefix = argvPrefix(environment: environment, suffix: ["send"]) else {
            return UnconfiguredSendClient()
        }
        return ChestnutSendClient(process: makeProcess(), argvPrefix: argvPrefix)
    }

    static func makeStreamClient(environment: [String: String] = ProcessInfo.processInfo.environment) -> any StreamClient {
        // phase 2003：重开只恢复当前活跃 turn（压缩快照 + 同边界 tail），不重放已结束 turn
        guard let argvPrefix = argvPrefix(environment: environment, suffix: ["stream", "--from-current-turn"]) else {
            return UnconfiguredStreamClient()
        }
        return ChestnutStreamClient(process: makeProcess(), argvPrefix: argvPrefix)
    }

    static func makeSetupClient(environment: [String: String] = ProcessInfo.processInfo.environment) -> any SetupClient {
        guard let cliPath = environment["CHESTNUT_CLI_JS"], !cliPath.isEmpty else { return UnconfiguredSetupClient() }
        return ChestnutSetupClient(process: makeProcess(), argvPrefix: ["node", cliPath, "launcher", "setup", "--json"])
    }

    static func makeStartContinuation(environment: [String: String] = ProcessInfo.processInfo.environment) -> () async throws -> Void {
        return {
            guard let cliPath = environment["CHESTNUT_CLI_JS"], !cliPath.isEmpty else {
                throw ChatError.local(detail: "CHESTNUT_CLI_JS 未配置；无法启动 chestnut")
            }
            let output = try await makeProcess().run(["node", cliPath, "start", "--non-interactive", "--language", "auto"])
            guard output.exitCode == 0, output.terminationSignal == nil else {
                throw ChatError.rejected(detail: output.stderr.isEmpty ? "chestnut start failed" : output.stderr)
            }
        }
    }

    private static func makeProcess() -> MacOSChestnutProcess {
        MacOSChestnutProcess(executableURL: URL(fileURLWithPath: "/usr/bin/env"))
    }

    /// claw 名（仅用于拼 CLI argv 的 `claw <name>`；phase 2004 起 Swift 不再做
    /// claw bar 格式化——协议输出最终显示文本，Swift 只原样呈现）。
    private static func clawName(environment: [String: String]) -> String {
        environment["CHESTNUT_CLAW_NAME"].flatMap { $0.isEmpty ? nil : $0 } ?? "motion"
    }

    private static func argvPrefix(environment: [String: String], suffix: [String]) -> [String]? {
        guard let cliPath = environment["CHESTNUT_CLI_JS"], !cliPath.isEmpty else { return nil }
        return ["node", cliPath, "claw", clawName(environment: environment)] + suffix
    }
}

struct UnconfiguredSetupClient: SetupClient {
    private func missing() -> ChatError { .local(detail: "CHESTNUT_CLI_JS 未配置；无法查询初始化状态") }
    func status() async throws -> SetupState { throw missing() }
    func selectProvider(_ providerId: String) async throws -> SetupState { throw missing() }
    func submit(_ input: SetupInput) async throws -> SetupState { throw missing() }
    func retry() async throws -> SetupState { throw missing() }
    func cancel() async throws -> SetupState { throw missing() }
}

struct UnconfiguredSendClient: SendClient {
    func submit(requestId: RequestId, text: String) async throws -> SendAck {
        // phase 2004：Swift 本地错误保持本地纯文本（不伪装 claw bar 形状），UI 原样显示
        throw ChatError.local(detail: "CHESTNUT_CLI_JS 未配置；launcher 不自行启动 chestnut")
    }
}

struct UnconfiguredStreamClient: StreamClient {
    func events(fromSequence: Int?) -> AsyncThrowingStream<LauncherEnvelope, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: ChatError.local(detail: "CHESTNUT_CLI_JS 未配置；launcher 不自行启动 chestnut"))
        }
    }

    func stop() async {}
}

final class LauncherAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var rootController: LauncherRootController?
    private var hotKeyController: LauncherHotKeyController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rootController = LauncherRootController(
            setupClient: LauncherClientFactory.makeSetupClient(),
            startNonInteractive: LauncherClientFactory.makeStartContinuation(),
            makeStore: {
                ChatStore(send: LauncherClientFactory.makeSendClient(), stream: LauncherClientFactory.makeStreamClient())
            }
        )
        self.rootController = rootController

        // 初始 compact：仅一行输入框高度；内容由 ChatView 测量后经 onWindowHeightChange 上报，
        // panel 按三态动画 resize（顶部锚定、保持 key window）。
        let window = LauncherPanel(contentRect: NSRect(
            x: 0, y: 0,
            width: ConversationLayout.width,
            height: ConversationLayout.compactHeight
        ))
        window.title = "Chestnut Launcher"
        let view = LauncherRootView(controller: rootController, onWindowHeightChange: { [weak window] height in
            window?.resize(toHeight: height)
        })
        window.contentView = NSHostingView(rootView: view)
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window

        let hotKeyController = LauncherHotKeyController { [weak self] in
            self?.toggleLauncher()
        }
        self.hotKeyController = hotKeyController
        do {
            try hotKeyController.start()
        } catch {
            // 冲突或注册失败不阻止手动启动、reopen 和 Esc/失焦隐藏。
            NSLog("Option-Space global hotkey registration failed: \(error)")
        }
    }

    func toggleLauncher() {
        LauncherAppDelegate.toggle(window: window)
    }

    static func toggle(window: NSWindow?) {
        guard let window else { return }
        if window.isVisible && window.isKeyWindow {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// 关闭只隐藏：未 ack 草稿与订阅状态不动；重新唤出显示最近已确认事实。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotKeyController?.stop()
        guard let rootController, case let .chat(store) = rootController.state else { return }
        let done = DispatchSemaphore(value: 0)
        Task {
            await store.stopStream()
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }
}
