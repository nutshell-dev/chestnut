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

/// CLI 装配：生产默认使用随包 Node/CLI 和用户数据目录；显式环境变量仅作开发覆盖。
/// 定位失败返回本地失败的 client（degraded、不伪造连接成功）；不自动启动 daemon。
enum LauncherClientFactory {
    static func makeSendClient(environment: [String: String] = ProcessInfo.processInfo.environment) -> any SendClient {
        do {
            let resources = try runtimeResources(environment: environment)
            return ChestnutLauncherSendClient(
                process: makeProcess(resources: resources),
                argv: launcherArgv(resources: resources, command: "send")
            )
        } catch {
            return UnconfiguredSendClient(detail: runtimeErrorDetail(error))
        }
    }

    static func makeStreamClient(environment: [String: String] = ProcessInfo.processInfo.environment) -> any StreamClient {
        do {
            let resources = try runtimeResources(environment: environment)
            // phase 2003：重开只恢复当前活跃 turn（压缩快照 + 同边界 tail），不重放已结束 turn
            let argvPrefix = launcherArgv(
                resources: resources,
                command: "stream",
                options: ["--from-current-turn"]
            )
            return ChestnutStreamClient(process: makeProcess(resources: resources), argvPrefix: argvPrefix)
        } catch {
            return UnconfiguredStreamClient(detail: runtimeErrorDetail(error))
        }
    }

    static func makeSetupClient(environment: [String: String] = ProcessInfo.processInfo.environment) -> any SetupClient {
        do {
            let resources = try runtimeResources(environment: environment)
            return ChestnutSetupClient(
                process: makeProcess(resources: resources),
                argvPrefix: launcherArgv(resources: resources, command: "setup"),
                statusArgv: launcherArgv(resources: resources, command: "status")
            )
        } catch {
            return UnconfiguredSetupClient(detail: runtimeErrorDetail(error))
        }
    }

    static func makeStartContinuation(environment: [String: String] = ProcessInfo.processInfo.environment) -> (String?) async throws -> Void {
        return { languageSample in
            let resources: LauncherRuntimeResources
            do {
                resources = try runtimeResources(environment: environment)
            } catch {
                throw ChatError.local(detail: runtimeErrorDetail(error))
            }
            var request: [String: Any] = ["command": "start"]
            if let languageSample { request["languageSample"] = languageSample }
            let requestData = try JSONSerialization.data(withJSONObject: request)
            let output = try await makeProcess(resources: resources).run(
                launcherArgv(resources: resources, command: "start"),
                stdin: String(decoding: requestData, as: UTF8.self) + "\n"
            )
            guard output.exitCode == 0, output.terminationSignal == nil, let line = output.stdoutLines.first else {
                throw ChatError.rejected(detail: output.stderr.isEmpty ? "launcher start failed" : output.stderr)
            }
            let envelope = try LauncherWireDecoder().decode(line: line)
            guard envelope.kind == .daemon,
                  envelope.payload["state"]?.stringValue == "running",
                  envelope.onboarding != nil else {
                throw ChatError.rejected(detail: envelope.payload["detail"]?.stringValue ?? "launcher runtime not ready")
            }
        }
    }

    static func runtimeResources(
        environment: [String: String],
        bundle: Bundle = .main,
        fileSystem: any LauncherRuntimeFileSystem = LauncherFileSystem()
    ) throws -> LauncherRuntimeResources {
        try LauncherRuntimeResources.resolve(environment: environment, bundle: bundle, fileSystem: fileSystem)
    }

    private static func makeProcess(resources: LauncherRuntimeResources) -> MacOSChestnutProcess {
        MacOSChestnutProcess(executableURL: resources.nodeURL, environment: resources.processEnvironment)
    }

    static func launcherArgv(
        resources: LauncherRuntimeResources,
        command: String,
        options: [String] = []
    ) -> [String] {
        [resources.cliURL.path, "launcher", command, "--json"] + options
    }

    private static func runtimeErrorDetail(_ error: Error) -> String {
        if let error = error as? LauncherRuntimeResourceError { return error.detail }
        return "Chestnut 运行资源定位失败：\(error.localizedDescription)。请检查应用完整性。"
    }
}

struct UnconfiguredSetupClient: SetupClient {
    var detail = "Chestnut 运行资源未配置；无法查询初始化状态"
    private func missing() -> ChatError { .local(detail: detail) }
    func status() async throws -> SetupState { throw missing() }
    func selectProvider(_ providerId: String) async throws -> SetupState { throw missing() }
    func submit(_ input: SetupInput) async throws -> SetupState { throw missing() }
    func retry() async throws -> SetupState { throw missing() }
    func cancel() async throws -> SetupState { throw missing() }
}

struct UnconfiguredSendClient: SendClient {
    var detail = "Chestnut 运行资源未配置；launcher 不自行启动 chestnut"
    func submit(requestId: RequestId, text: String) async throws -> SendAck {
        // phase 2004：Swift 本地错误保持本地纯文本（不伪装 claw bar 形状），UI 原样显示
        throw ChatError.local(detail: detail)
    }
}

struct UnconfiguredStreamClient: StreamClient {
    var detail = "Chestnut 运行资源未配置；launcher 不自行启动 chestnut"
    func events(fromSequence: Int?) -> AsyncThrowingStream<LauncherEnvelope, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: ChatError.local(detail: detail))
        }
    }

    func stop() async {}
}

final class LauncherAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, LauncherPanelDelegate {
    private var window: NSWindow?
    private var rootController: LauncherRootController?
    private var hotKeyController: LauncherHotKeyController?
    private var shortcutBubbleController: ShortcutBubbleController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        SetupPasteMenuTarget.install()
        let shortcutBubbleController = ShortcutBubbleController()
        self.shortcutBubbleController = shortcutBubbleController
        let rootController = LauncherRootController(
            setupClient: LauncherClientFactory.makeSetupClient(),
            startNonInteractive: LauncherClientFactory.makeStartContinuation(),
            makeStore: {
                ChatStore(send: LauncherClientFactory.makeSendClient(), stream: LauncherClientFactory.makeStreamClient())
            }
        )
        rootController.onSetupCompleted = { [weak self] in
            self?.shortcutBubbleController?.hide()
        }
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
            Task { @MainActor in self?.toggleLauncher() }
        }
        self.hotKeyController = hotKeyController
        do {
            try hotKeyController.start()
        } catch {
            // 冲突或注册失败不阻止手动启动、reopen 和 Esc/失焦隐藏。
            NSLog("Option-Space global hotkey registration failed: \(error)")
        }
    }

    @MainActor func toggleLauncher() {
        shortcutBubbleController?.hide()
        LauncherAppDelegate.toggle(window: window)
    }

    @MainActor func launcherPanelDidResign(_ panel: LauncherPanel, screen: NSScreen?) {
        guard rootController?.isSetupIncomplete == true,
              let screen = screen ?? NSScreen.main else { return }
        shortcutBubbleController?.panelDidResign(isSetupIncomplete: true, screen: screen)
    }

    static func toggle(window: NSWindow?) {
        guard let window else { return }
        if window.isVisible && window.isKeyWindow {
            if let panel = window as? LauncherPanel { panel.hideWithoutShortcutHint() } else { window.orderOut(nil) }
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// 关闭只隐藏：未 ack 草稿与订阅状态不动；重新唤出显示最近已确认事实。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if let panel = sender as? LauncherPanel { panel.hideWithoutShortcutHint() } else { sender.orderOut(nil) }
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        shortcutBubbleController?.hide()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        shortcutBubbleController?.hide()
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
