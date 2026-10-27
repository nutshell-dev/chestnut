import AppKit
import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Step B/C：panel 配置与生命周期单测。实机行为（Dock/Space/全屏/输入法/可读性）
/// 见 development log/phase1985-logs/step-c-window-matrix.md。
final class LauncherPanelTests: XCTestCase {
    override func setUpWithError() throws {
        _ = NSApplication.shared
    }

    private func makePanel() -> LauncherPanel {
        LauncherPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480))
    }

    func testActivationPolicyIsAccessory() {
        XCTAssertEqual(LauncherWindowPolicy.activation, .accessory, "不进 Dock/Cmd-Tab")
    }

    func testPanelIsAccessoryCompatible() {
        let panel = makePanel()
        XCTAssertTrue(panel.canBecomeKey, "必须能成为 key window 接收输入")
        XCTAssertTrue(panel.canBecomeMain)
        XCTAssertTrue(panel.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertFalse(panel.isOpaque)
    }

    func testPanelVisualAndLevelConfiguration() {
        let panel = makePanel()
        XCTAssertEqual(panel.level, .floating)
        XCTAssertEqual(panel.backgroundColor, .clear)
        XCTAssertTrue(panel.hasShadow)
        XCTAssertEqual(panel.titleVisibility, .hidden)
        XCTAssertTrue(panel.titlebarAppearsTransparent)
        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
        XCTAssertTrue(panel.styleMask.contains(.fullSizeContentView))
    }

    func testResignKeyHidesPanelWithoutTouchingState() {
        let panel = makePanel()
        panel.orderFront(nil)
        XCTAssertTrue(panel.isVisible)
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: panel)
        XCTAssertFalse(panel.isVisible, "失焦必须 orderOut 隐藏")
    }

    func testCloseHidesInsteadOfClosing() {
        let panel = makePanel()
        let delegate = LauncherAppDelegate()
        panel.orderFront(nil)
        let shouldClose = delegate.windowShouldClose(panel)
        XCTAssertFalse(shouldClose, "关闭请求必须被拦截")
        XCTAssertFalse(panel.isVisible, "关闭 = 隐藏，不退出、不动 ChatStore")
    }

    func testUnmodifiedEscapeHidesPanel() {
        let panel = makePanel()
        panel.orderFront(nil)
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: panel.windowNumber,
            context: nil,
            characters: "\u{1b}",
            charactersIgnoringModifiers: "\u{1b}",
            isARepeat: false,
            keyCode: 53
        )!
        XCTAssertTrue(panel.performKeyEquivalent(with: event))
        XCTAssertFalse(panel.isVisible, "Esc 只隐藏窗口，不提交、取消 turn 或清空状态")
    }

    func testModifiedEscapeIsNotConsumed() {
        let panel = makePanel()
        panel.orderFront(nil)
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.option],
            timestamp: 0,
            windowNumber: panel.windowNumber,
            context: nil,
            characters: "\u{1b}",
            charactersIgnoringModifiers: "\u{1b}",
            isARepeat: false,
            keyCode: 53
        )!
        XCTAssertFalse(LauncherPanel.isUnmodifiedEscape(event))
        XCTAssertFalse(panel.performKeyEquivalent(with: event))
        XCTAssertTrue(panel.isVisible)
    }

    func testCancelOperationHidesPanel() {
        let panel = makePanel()
        panel.orderFront(nil)
        panel.cancelOperation(nil)
        XCTAssertFalse(panel.isVisible)
    }

    func testToggleShowsHiddenPanelAndHidesVisibleKeyPanel() {
        let panel = makePanel()
        LauncherAppDelegate.toggle(window: panel)
        XCTAssertTrue(panel.isVisible)
        panel.makeKeyAndOrderFront(nil)
        LauncherAppDelegate.toggle(window: panel)
        XCTAssertFalse(panel.isVisible, "toggle 只改变 NSWindow 可见性，没有 ChatStore 参数")
    }
}
