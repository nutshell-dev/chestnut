import AppKit
import LauncherCore
import XCTest
@testable import LauncherMacOS

@MainActor
final class ShortcutBubbleTests: XCTestCase {
    func testBubbleIsNonactivatingAndDoesNotChangeDockPolicy() {
        _ = mainScreen()
        let controller = ShortcutBubbleController()
        defer { controller.hide() }
        let policy = NSApp.activationPolicy()
        controller.show(on: mainScreen())

        let window = controller.window
        XCTAssertTrue(controller.isVisible)
        XCTAssertEqual(window?.level, .floating)
        XCTAssertTrue(window?.styleMask.contains(.nonactivatingPanel) == true)
        XCTAssertFalse(window?.canBecomeKey ?? true)
        XCTAssertFalse(window?.canBecomeMain ?? true)
        let policyAfterShow = NSApp.activationPolicy()
        if policyAfterShow != policy { XCTFail("气泡不得改变 Dock/activation policy") }
        let content = window?.contentView
        let label = content?.subviews.compactMap { $0 as? NSTextField }.first
        XCTAssertEqual(label?.stringValue, "⌥ Space 重新打开 Chestnut")
    }

    func testShowOnlyOrdersFrontWithoutKeyOrActivation() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/LauncherMacOS/ShortcutBubbleController.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let show = source.components(separatedBy: "func show(on screen: NSScreen)")[1]
            .components(separatedBy: "func hide()")[0]

        XCTAssertTrue(show.contains("orderFrontRegardless()"))
        XCTAssertFalse(show.contains("makeKey("))
        XCTAssertFalse(show.contains("makeKeyAndOrderFront("))
        XCTAssertFalse(show.contains("NSApp.activate("))
    }

    func testVisibleFramePositionsBubbleAtBottomRightOnEveryScreen() {
        let first = ShortcutBubbleController.frame(
            visibleFrame: NSRect(x: 0, y: 0, width: 1440, height: 900)
        )
        let second = ShortcutBubbleController.frame(
            visibleFrame: NSRect(x: 1440, y: 40, width: 1920, height: 1040)
        )
        XCTAssertEqual(first, NSRect(x: 1120, y: 20, width: 300, height: 64))
        XCTAssertEqual(second, NSRect(x: 3040, y: 60, width: 300, height: 64))
    }

    func testSetupGateShowsOnlyWhileSetupIsIncomplete() {
        let controller = ShortcutBubbleController()
        defer { controller.hide() }
        controller.panelDidResign(isSetupIncomplete: false, screen: mainScreen())
        XCTAssertFalse(controller.isVisible)
        controller.panelDidResign(isSetupIncomplete: true, screen: mainScreen())
        XCTAssertTrue(controller.isVisible)
    }

    func testStaleTimeoutCannotHideANewerBubble() {
        let controller = ShortcutBubbleController()
        defer { controller.hide() }
        controller.show(on: mainScreen())
        let oldGeneration = controller.generation
        controller.show(on: mainScreen())

        controller.handleTimeout(generation: oldGeneration)
        XCTAssertTrue(controller.isVisible)
        controller.handleTimeout(generation: controller.generation)
        XCTAssertFalse(controller.isVisible)
    }

    func testScheduledTimeoutHidesBubble() async {
        let controller = ShortcutBubbleController(timeout: 0.02)
        defer { controller.hide() }
        controller.show(on: mainScreen())
        XCTAssertTrue(controller.isVisible)
        try? await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertFalse(controller.isVisible)
    }

    func testPanelResignHidesThenNotifiesDelegateWithPreviousScreen() {
        _ = mainScreen()
        let panel = LauncherPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 92))
        let delegate = PanelDelegateSpy()
        panel.delegate = delegate
        panel.makeKeyAndOrderFront(nil)
        let previousScreen = panel.screen
        delegate.screens.removeAll()

        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: panel)
        XCTAssertFalse(panel.isVisible)
        XCTAssertEqual(delegate.screens.count, 1)
        XCTAssertTrue(delegate.screens.first == previousScreen)
    }

    func testExplicitEscapeHideDoesNotRequestShortcutBubble() {
        _ = mainScreen()
        let panel = LauncherPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 92))
        let delegate = PanelDelegateSpy()
        panel.delegate = delegate
        panel.makeKeyAndOrderFront(nil)

        panel.cancelOperation(nil)
        XCTAssertFalse(panel.isVisible)
        XCTAssertTrue(delegate.screens.isEmpty)
    }

    func testSetupCompletionPublishesOnceAndDisablesFutureBubbleCondition() async {
        let controller = LauncherRootController(
            setupClient: ReadySetupClient(),
            startNonInteractive: { _ in },
            makeStore: { ChatStore(send: UnconfiguredSendClient(), stream: UnconfiguredStreamClient()) }
        )
        var completions = 0
        controller.onSetupCompleted = { completions += 1 }
        XCTAssertTrue(controller.isSetupIncomplete)

        await controller.load()
        guard case .chat = controller.state else { return XCTFail("expected chat") }
        XCTAssertFalse(controller.isSetupIncomplete)
        XCTAssertEqual(completions, 1)
        await controller.load()
        XCTAssertEqual(completions, 1)
    }

    private func mainScreen() -> NSScreen {
        _ = NSApplication.shared
        return NSScreen.main ?? NSScreen.screens.first!
    }

    func testAppLifecycleRevokesBubbleOnHotkeyReopenAndSetupCompletion() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/LauncherMacOS/LauncherApp.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let toggle = source.components(separatedBy: "func toggleLauncher()")[1]
            .components(separatedBy: "func launcherPanelDidResign")[0]
        let resign = source.components(separatedBy: "func launcherPanelDidResign")[1]
            .components(separatedBy: "static func toggle")[0]
        let reopen = source.components(separatedBy: "func applicationShouldHandleReopen")[1]
            .components(separatedBy: "func applicationWillTerminate")[0]

        XCTAssertTrue(toggle.contains("shortcutBubbleController?.hide()"))
        XCTAssertTrue(resign.contains("rootController?.isSetupIncomplete == true"))
        XCTAssertTrue(reopen.contains("shortcutBubbleController?.hide()"))
        XCTAssertTrue(source.contains("rootController.onSetupCompleted"))
    }
}

private final class PanelDelegateSpy: NSObject, NSWindowDelegate, LauncherPanelDelegate {
    var screens: [NSScreen?] = []

    @MainActor func launcherPanelDidResign(_ panel: LauncherPanel, screen: NSScreen?) {
        screens.append(screen)
    }
}

private final class ReadySetupClient: SetupClient, @unchecked Sendable {
    func status() async throws -> SetupState { .committed }
    func selectProvider(_ providerId: String) async throws -> SetupState { .committed }
    func submit(_ input: SetupInput) async throws -> SetupState { .committed }
    func retry() async throws -> SetupState { .committed }
    func cancel() async throws -> SetupState { .committed }
}
