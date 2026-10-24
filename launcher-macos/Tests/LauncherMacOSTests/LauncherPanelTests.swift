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
}
