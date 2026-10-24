import AppKit
import Foundation
import LauncherCore
import SwiftUI
import XCTest
@testable import LauncherMacOS

/// Step D：Spotlight 输入区视觉不变量——常量单一来源、plain 无边框、
/// placeholder、busy 状态槽不改变布局。
@MainActor
final class ComposerStyleTests: XCTestCase {
    func testGeometryConstants() {
        XCTAssertEqual(ComposerStyle.height, 54)
        XCTAssertEqual(ComposerStyle.cornerRadius, 16)
        XCTAssertEqual(ComposerStyle.horizontalPadding, 18)
        XCTAssertEqual(ComposerStyle.statusSlotWidth, 20)
        XCTAssertEqual(ComposerStyle.fontSize, 17)
        XCTAssertEqual(ComposerStyle.placeholder, "询问 Motion…")
    }

    /// compact 态窗口（76）必须容得下输入栏（54）加根 padding（20）。
    func testComposerFitsCompactHeight() {
        XCTAssertTrue(ComposerStyle.height + 20 <= ConversationLayout.compactHeight, "composer(54)+padding(20) 必须容于 compactHeight(76)")
    }

    private func firstTextField(in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField { return field }
        return view.subviews.compactMap { firstTextField(in: $0) }.first
    }

    private func host(_ store: ChatStore) -> NSHostingView<ChatView> {
        let hosting = NSHostingView(rootView: ChatView(store: store))
        hosting.frame = NSRect(x: 0, y: 0, width: ConversationLayout.width, height: ConversationLayout.compactHeight)
        hosting.layoutSubtreeIfNeeded()
        return hosting
    }

    private func settle(_ hosting: NSHostingView<ChatView>) async {
        for _ in 0 ..< 20 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func testComposerIsBorderlessWithSpotlightPlaceholder() async {
        let store = ChatStore(send: MockSendClient(), stream: ScriptedStreamClient(scripts: []))
        let hosting = host(store)
        await settle(hosting)

        let field = firstTextField(in: hosting)
        XCTAssertNotNil(field, "composer 输入框必须存在")
        XCTAssertFalse(field?.isBordered ?? true, "Spotlight 风格输入框不得有系统边框")
        XCTAssertEqual(field?.placeholderString, ComposerStyle.placeholder)
    }
}
