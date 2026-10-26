import AppKit
import LauncherCore
import SwiftUI
import XCTest
@testable import LauncherMacOS

/// Phase 2007 Step C/D：流式贴底机制回归——document/viewport 几何、revision 门控、
/// 重试上限；以及真实 ChatView 流式增长后的贴底收敛。
@MainActor
final class ScrollFollowTests: XCTestCase {
    typealias AnchorView = ScrollFollowAnchor.AnchorView

    /// 翻转文档（与 SwiftUI ScrollView 的 document 一致：origin.y=0 在顶部）。
    private final class FlippedDocument: NSView {
        override var isFlipped: Bool { true }
    }

    private func makeScrollEnvironment(docHeight: CGFloat = 1000, viewport: CGFloat = 200) -> (NSScrollView, AnchorView) {
        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: viewport))
        scrollView.hasVerticalScroller = true
        let document = FlippedDocument(frame: NSRect(x: 0, y: 0, width: 400, height: docHeight))
        scrollView.documentView = document
        let anchor = AnchorView(frame: NSRect(x: 0, y: docHeight - 1, width: 1, height: 1))
        document.addSubview(anchor)
        return (scrollView, anchor)
    }

    /// 贴底结果断言：滚动后 viewport 底 == document 底。
    func testScrollToBottomPinsDocumentBottom() {
        let (scrollView, anchor) = makeScrollEnvironment()
        XCTAssertTrue(anchor.scrollToBottom())
        XCTAssertLessThanOrEqual(abs(scrollView.documentVisibleRect.maxY - 1000), 0.5)
        XCTAssertTrue(anchor.isPinnedToBottom())
    }

    /// 内容未溢出时不滚动（y <= 0 → false，viewport 保持原位）。
    func testScrollToBottomNoOpWhenContentFits() {
        let (scrollView, anchor) = makeScrollEnvironment(docHeight: 150, viewport: 200)
        XCTAssertFalse(anchor.scrollToBottom())
        XCTAssertLessThanOrEqual(abs(scrollView.documentVisibleRect.origin.y), 0.5)
    }

    /// revision 去重：同一 revision 重复请求只计一次；新 revision 才重新武装。
    func testDuplicateRevisionRequestsAreDeduplicated() {
        let (_, anchor) = makeScrollEnvironment()
        anchor.requestPostLayoutScrollToBottom(revision: 1)
        anchor.requestPostLayoutScrollToBottom(revision: 1)
        XCTAssertEqual(anchor.requestCount, 1, "重复 revision 必须去重（无关重渲染不触发滚动）")
        anchor.requestPostLayoutScrollToBottom(revision: 2)
        XCTAssertEqual(anchor.requestCount, 2)
    }

    /// layout pass 消费 revision：成功后同一 revision 的后续 layout 不再滚动——
    /// 用户手动上滚不会被同一条内容的残余 layout pass 拽回（只有新内容才贴底）。
    func testLayoutConsumesRevisionOnce() {
        let (scrollView, anchor) = makeScrollEnvironment()
        anchor.requestPostLayoutScrollToBottom(revision: 7)
        anchor.layout()
        XCTAssertTrue(anchor.isPinnedToBottom(), "layout pass 后必须贴底")

        // 用户上滚；同一 revision 的又一次 layout 不得拽回
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: 0))
        anchor.layout()
        XCTAssertLessThanOrEqual(abs(scrollView.documentVisibleRect.origin.y), 0.5,
                       "同 revision 残余 layout 不得重复滚动")

        // 新 revision（新内容）才重新贴底
        anchor.requestPostLayoutScrollToBottom(revision: 8)
        anchor.layout()
        XCTAssertTrue(anchor.isPinnedToBottom())
    }

    /// 重试链边界：上限与间隔是有界常量（防无限重试）；新 revision 取消旧链
    /// （代际递增由 requestCount 递增间接锁定，链行为归实机 probe）。
    func testRetryChainIsBounded() {
        XCTAssertGreaterThan(AnchorView.maxNudgeAttempts, 0)
        XCTAssertLessThanOrEqual(AnchorView.maxNudgeAttempts, 20)
        XCTAssertGreaterThan(AnchorView.nudgeInterval, 0)
        XCTAssertLessThanOrEqual(AnchorView.nudgeInterval, 0.05, "重试间隔必须远小于流式块节奏")
    }

    /// 端到端：真实 ChatView 流式增长（同 messageId 快照 upsert）后回复区收敛贴底——
    /// proxy scrollTo 已被证明在流式事务中丢弃（step-a 事实），本测试锁 post-layout 锚。
    func testStreamingGrowthKeepsScrollPinnedToBottom() async {
        let chunk = "流式回复片段，用于让回复区内容逐步超出可视高度。"
        var envelopes: [LauncherEnvelope] = []
        var text = ""
        for i in 1 ... 40 {
            text += chunk
            envelopes.append(LauncherEnvelope(
                protocolVersion: LauncherEnvelope.supportedProtocolVersion,
                sequence: i, sessionId: "s1", kind: .event,
                payload: .object(["messageId": .string("r1"), "role": .string("motion"), "text": .string(text)])
            ))
        }
        let stream = ScriptedStreamClient(scripts: [.init(envelopes: envelopes)])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        store.startStream()

        let hosting = NSHostingView(rootView: ChatView(store: store))
        hosting.frame = NSRect(x: 0, y: 0, width: ConversationLayout.width, height: 496)
        hosting.layoutSubtreeIfNeeded()
        for _ in 0 ..< 20 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(store.state.messages.count, 1)
        guard let scrollView = findScrollView(in: hosting), let doc = scrollView.documentView else {
            return XCTFail("回复区 ScrollView 必须存在")
        }
        XCTAssertGreaterThan(
            doc.frame.height, scrollView.documentVisibleRect.height,
            "前提：内容必须溢出回复区（capped 内部滚动）"
        )
        // 收敛等待：无 display link 环境下布局提交靠显式 layout 驱动，重试链在其间收敛
        var pinned = false
        for _ in 0 ..< 40 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(nanoseconds: 5_000_000)
            if abs(scrollView.documentVisibleRect.maxY - doc.frame.height) <= 2 {
                pinned = true
                break
            }
        }
        XCTAssertTrue(pinned, "流式增长后回复区必须收敛到贴底（不依赖 turn_end/footer 撤销）")
    }

    private func findScrollView(in view: NSView) -> NSScrollView? {
        if let scrollView = view as? NSScrollView { return scrollView }
        return view.subviews.compactMap { findScrollView(in: $0) }.first
    }
}
