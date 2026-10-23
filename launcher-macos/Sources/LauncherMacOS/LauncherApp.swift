import AppKit
import LauncherCore
import SwiftUI

/// @main 入口：AppKit 负责标准 NSWindow 生命周期，SwiftUI 负责视图。
/// 窗口关闭只隐藏（orderOut），不触碰 ChatStore 状态；应用退出统一停止 stream task。
@main
enum LauncherApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = LauncherAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
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
        guard let argvPrefix = argvPrefix(environment: environment, suffix: ["stream"]) else {
            return UnconfiguredStreamClient()
        }
        return ChestnutStreamClient(process: makeProcess(), argvPrefix: argvPrefix)
    }

    private static func makeProcess() -> any ChestnutProcess {
        MacOSChestnutProcess(executableURL: URL(fileURLWithPath: "/usr/bin/env"))
    }

    private static func argvPrefix(environment: [String: String], suffix: [String]) -> [String]? {
        guard let cliPath = environment["CHESTNUT_CLI_JS"], !cliPath.isEmpty else { return nil }
        let claw = environment["CHESTNUT_CLAW_NAME"].flatMap { $0.isEmpty ? nil : $0 } ?? "motion"
        return ["node", cliPath, "claw", claw] + suffix
    }
}

struct UnconfiguredSendClient: SendClient {
    func submit(requestId: RequestId, text: String) async throws -> SendAck {
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
    private var store: ChatStore?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = ChatStore(
            send: LauncherClientFactory.makeSendClient(),
            stream: LauncherClientFactory.makeStreamClient()
        )
        self.store = store

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Chestnut Launcher"
        window.contentView = NSHostingView(rootView: ChatView(store: store))
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    /// 关闭只隐藏：未 ack 草稿与订阅状态不动；重新唤出显示最近已确认事实。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard let store else { return }
        let done = DispatchSemaphore(value: 0)
        Task {
            await store.stopStream()
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }
}
