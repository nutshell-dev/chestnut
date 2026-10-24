import AppKit
import Foundation
import LauncherCore
import SwiftUI
import XCTest
@testable import LauncherMacOS

/// Step C：三态视图层级断言（不依赖截图像素）。
/// compact：无回复区 ScrollView；expanded：回复区出现；composer 恒在顶部。
/// 布局输入（stream 增量、draft、错误的 messages 事实）由 ChatStoreIntegrationTests 锁定。
@MainActor
final class ChatViewSnapshotTests: XCTestCase {
    private func makeStore(messages: Int) -> ChatStore {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        return store
    }

    private func host(_ view: ChatView) -> NSHostingView<ChatView> {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(x: 0, y: 0, width: ConversationLayout.width, height: 496)
        hosting.layoutSubtreeIfNeeded()
        return hosting
    }

    private func containsSubview<T: NSView>(_ type: T.Type, in view: NSView) -> Bool {
        if view is T { return true }
        return view.subviews.contains { containsSubview(type, in: $0) }
    }

    private func settle(_ hosting: NSHostingView<ChatView>) async {
        // 让 SwiftUI 完成状态驱动的重渲染（无窗口环境下无 display link，用显式 layout + 短暂让出）。
        for _ in 0 ..< 20 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func testCompactHidesResponseArea() async {
        let store = makeStore(messages: 0)
        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertTrue(store.state.messages.isEmpty)
        XCTAssertTrue(containsSubview(NSTextField.self, in: hosting), "composer 必须存在")
        XCTAssertFalse(containsSubview(NSScrollView.self, in: hosting), "compact 态不渲染回复区")
    }

    func testExpandedShowsResponseAreaWithComposerOnTop() async {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(), stream: stream, makeRequestId: { "req-1" })
        store.updateDraft("你好")
        await store.submit()
        XCTAssertEqual(store.state.messages.count, 1)

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertTrue(containsSubview(NSTextField.self, in: hosting), "composer 必须存在")
        XCTAssertTrue(containsSubview(NSScrollView.self, in: hosting), "expanded 态必须渲染回复区")
    }

    /// 窗口高度语义：expanded 随内容、达到上限固定；这里锁定 ChatView 上报链
    /// （onWindowHeightChange）在消息出现后给出大于 compact 的目标高度。
    func testWindowHeightCallbackReportsExpandedTarget() async {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(), stream: stream, makeRequestId: { "req-1" })
        store.updateDraft("你好")
        await store.submit()

        let recorder = HeightRecorder()
        let hosting = host(ChatView(store: store, onWindowHeightChange: { h in recorder.record(h) }))
        await settle(hosting)
        XCTAssertTrue(
            recorder.heights.contains { $0 > ConversationLayout.compactHeight },
            "消息出现后应上报大于 compact 的窗口高度，实际: \(recorder.heights)"
        )
        XCTAssertTrue(
            recorder.heights.allSatisfy { $0 <= ConversationLayout.expandedHeight },
            "上报高度不得超过上限 \(ConversationLayout.expandedHeight)"
        )
    }
}

@MainActor
private final class HeightRecorder {
    private(set) var heights: [CGFloat] = []
    func record(_ height: CGFloat) { heights.append(height) }
}
