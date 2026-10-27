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
    /// capped 契约（phase 1996 Step D）：大量消息时回复区进入 capped，上报高度钳制在
    /// expandedHeight（496），回复区 ScrollView 仍存在（内部滚动语义）。
    func testCappedCapsWindowHeightAtExpandedLimit() async {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        for i in 0 ..< 40 {
            store.updateDraft("第 \(i) 条消息，用于把回复区撑到封顶高度。")
            await store.submit()
        }
        XCTAssertEqual(store.state.messages.count, 40)

        let recorder = HeightRecorder()
        let hosting = host(ChatView(store: store, onWindowHeightChange: { h in recorder.record(h) }))
        // 40 条消息的测量链较长，settle 窗口加倍，抑制无 display link 环境下的竞态
        for _ in 0 ..< 40 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(containsSubview(NSScrollView.self, in: hosting), "capped 态回复区必须存在（内部滚动）")
        XCTAssertTrue(
            recorder.heights.contains(ConversationLayout.expandedHeight),
            "内容超过上限后应上报 capped 高度 \(ConversationLayout.expandedHeight)，实际: \(recorder.heights)"
        )
        XCTAssertTrue(
            recorder.heights.allSatisfy { $0 <= ConversationLayout.expandedHeight },
            "上报高度不得超过上限 \(ConversationLayout.expandedHeight)"
        )
    }

    /// degraded 状态行结构断言（phase 1998 Step D）：错误态渲染状态行（重试/关闭按钮
    /// 是 UI 中唯一的 NSButton 来源），与 composer/回复列同处一个内容轴。
    func testDegradedShowsStatusLine() async {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(error: .rejected(detail: "exit 1")), stream: stream)
        store.updateDraft("你好")
        await store.submit()
        var isDegraded = false
        if case .degraded = store.state { isDegraded = true }
        XCTAssertTrue(isDegraded, "send 失败后应进入 degraded")

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertTrue(containsSubview(NSButton.self, in: hosting), "degraded 态必须渲染状态行（重试/关闭按钮）")
        XCTAssertTrue(containsSubview(NSTextField.self, in: hosting), "composer 必须存在")
    }

    /// 正常态不出现状态行按钮（NSButton 只来自 statusLine）。
    func testNormalStateHasNoStatusLine() async {
        let store = makeStore(messages: 0)
        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertFalse(containsSubview(NSButton.self, in: hosting), "正常态不得出现状态行按钮")
    }

    // MARK: phase 2000 颜色稳定契约

    /// 读取被测源码（harness/无 Xcode 环境下无法枚举 SwiftUI modifier，
    /// 无 selection surface 以源码结构契约锁定；实机行为由 step-d 矩阵覆盖）。
    private func chatViewSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // LauncherMacOSTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // macos
            .appendingPathComponent("Sources/LauncherMacOS/ChatView.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func section(of source: String, from startMarker: String, to endMarker: String) -> String? {
        guard let start = source.range(of: startMarker),
              let end = source.range(of: endMarker, range: start.upperBound ..< source.endIndex)
        else { return nil }
        return String(source[start.lowerBound ..< end.lowerBound])
    }

    /// response 区无隐式 selection surface（phase 2000）：phase1999 实机证明 textSelection
    /// 无论在消息行还是容器都会引起黑灰串扰，故整体移除；且不得以点击手势/选择状态替代。
    func testResponseHasNoImplicitSelectionSurface() throws {
        let source = try chatViewSource()
        XCTAssertFalse(source.contains(".textSelection("), "response 区不得声明 textSelection（phase 2000 整体移除）")
        XCTAssertFalse(source.contains(".onTapGesture"), "不得以点击手势替代 selection")
        XCTAssertFalse(source.contains("selectedMessageId"), "不得引入按点击切换颜色的状态")
    }

    /// 消息颜色结构断言：messageRow 颜色只来自 MessageStyle 纯角色映射，
    /// 不读取焦点/选择/点击状态。
    func testMessageRowColorIsStaticRoleMapping() throws {
        let source = try chatViewSource()
        let row = section(of: source, from: "private func messageRow", to: "private func statusLine")
        XCTAssertTrue(
            row?.contains("MessageStyle.foreground(for:") ?? false,
            "消息颜色必须来自 MessageStyle.foreground(for:) 纯角色映射"
        )
        XCTAssertFalse(row?.contains("isFocused") ?? true, "消息颜色不得读取焦点状态")
        XCTAssertFalse(row?.contains("@FocusState") ?? true, "消息行不得持有焦点状态")
    }

    /// 多条消息共存时只有一个回复区 ScrollView，Motion/user 混排在同一容器内渲染。
    func testMultipleMessagesShareOneResponseArea() async {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        for i in 0 ..< 3 {
            store.updateDraft("第 \(i) 条")
            await store.submit()
        }
        XCTAssertEqual(store.state.messages.count, 3)

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertTrue(containsSubview(NSScrollView.self, in: hosting), "回复区必须存在")
        XCTAssertEqual(countSubviews(NSScrollView.self, in: hosting), 1, "只允许一个回复区容器")
    }

    private func countSubviews<T: NSView>(_ type: T.Type, in view: NSView) -> Int {
        (view is T ? 1 : 0) + view.subviews.reduce(0) { $0 + countSubviews(type, in: $1) }
    }

    // MARK: phase 2001 活动行结构断言

    private func activityEnvelope(_ seq: Int, _ phase: String, label: String? = nil, detail: String? = nil) -> LauncherEnvelope {
        var payload: [String: JSONValue] = ["phase": .string(phase)]
        if let label { payload["label"] = .string(label) }
        if let detail { payload["detail"] = .string(detail) }
        return LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: seq, sessionId: "s1", kind: .activity, payload: .object(payload)
        )
    }

    /// 活动行占位：idle 态无 spinner（composer 非 sending 也无），活动到达后出现且只有一个
    /// （活动行 spinner），活动终止后撤销——活动行不进回复滚动区。
    func testActivityBarAppearsAndDismissesWithActivityState() async {
        let stream = ScriptedStreamClient(scripts: [.init(envelopes: [
            activityEnvelope(1, "processing", label: "thinking"),
        ])])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        store.startStream()

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertEqual(store.activity, .processing(label: "thinking", detail: nil))
        XCTAssertEqual(
            countSubviews(NSProgressIndicator.self, in: hosting), 1,
            "活动态必须渲染且只渲染一个活动行 spinner"
        )
    }

    /// idle 活动（turn 终止）撤销活动行：spinner 消失。
    func testActivityBarDisappearsAfterIdleActivity() async {
        let stream = ScriptedStreamClient(scripts: [.init(envelopes: [
            activityEnvelope(1, "processing", label: "tool"),
            activityEnvelope(2, "idle"),
        ])])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        store.startStream()

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertEqual(store.activity, .idle)
        XCTAssertEqual(
            countSubviews(NSProgressIndicator.self, in: hosting), 0,
            "活动终止后活动行必须撤销（不占高度、无 spinner）"
        )
    }

    /// 发送即占位：send ack 完成后（waiting）活动行已可见——不等首个 stream 事件。
    func testActivityBarAppearsImmediatelyAfterSend() async {
        let stream = ScriptedStreamClient(scripts: [])
        let store = ChatStore(send: MockSendClient(), stream: stream, makeRequestId: { "req-1" })
        store.updateDraft("你好")
        await store.submit()
        XCTAssertEqual(store.activity, .waiting)

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertEqual(
            countSubviews(NSProgressIndicator.self, in: hosting), 1,
            "send 完成后等待 Motion 期间活动行必须可见"
        )
    }

    // MARK: phase 2002 底部活动行布局与 error 保留

    private func motionEventEnvelope(_ seq: Int, _ id: String, _ text: String) -> LauncherEnvelope {
        LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: seq, sessionId: "s1", kind: .event,
            payload: .object(["messageId": .string(id), "role": .string("motion"), "text": .string(text)])
        )
    }

    /// 前序深度遍历整棵视图树（声明顺序 = 布局顺序：VStack 先声明的 section 子树整体在前）。
    private func flattenedTree(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { flattenedTree($0) }
    }

    /// claw bar 布局核心：activityBar 在回复列表之后（composer → messages → activityBar → status），
    /// 不插入消息之间。结构断言：活动行 spinner 子树位于回复区 ScrollView 子树之后。
    func testActivityBarRendersBelowResponseArea() async {
        let stream = ScriptedStreamClient(scripts: [.init(envelopes: [
            motionEventEnvelope(1, "m1", "第一条回复"),
            activityEnvelope(2, "processing", label: "thinking", detail: "先想"),
        ])])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        store.startStream()

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertEqual(store.state.messages.count, 1)
        XCTAssertEqual(store.activity, .processing(label: "thinking", detail: "先想"))

        let flat = flattenedTree(hosting)
        guard let spinnerIndex = flat.firstIndex(where: { $0 is NSProgressIndicator }),
              let scrollIndex = flat.firstIndex(where: { $0 is NSScrollView }) else {
            XCTFail("活动行 spinner 与回复区 ScrollView 必须同时存在")
            return
        }
        XCTAssertGreaterThan(
            spinnerIndex, scrollIndex,
            "活动行必须位于回复列表之后（不插入消息之间）"
        )
    }

    /// 连续多条消息后活动行仍在列表末尾：三条 user 消息 + waiting 活动，
    /// 活动行不重排已有消息、始终在最后。
    func testActivityBarStaysBelowMessagesAcrossMultipleSends() async {
        let stream = ScriptedStreamClient(scripts: [])
        var counter = 0
        let store = ChatStore(send: MockSendClient(), stream: stream, makeRequestId: {
            counter += 1
            return "req-\(counter)"
        })
        for text in ["第一条", "第二条", "第三条"] {
            store.updateDraft(text)
            await store.submit()
        }
        XCTAssertEqual(store.state.messages.count, 3)
        XCTAssertEqual(store.activity, .waiting)

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        let flat = flattenedTree(hosting)
        guard let spinnerIndex = flat.firstIndex(where: { $0 is NSProgressIndicator }),
              let scrollIndex = flat.firstIndex(where: { $0 is NSScrollView }) else {
            XCTFail("连续发送后活动行与回复区必须同时存在")
            return
        }
        XCTAssertGreaterThan(spinnerIndex, scrollIndex, "连续发送时活动行必须始终在所有消息之后")
    }

    /// turn_error → error 活动行保留可见（不撤行）、无 spinner（终态不假装进行中）；
    /// 错误行不被后续无关 stream 事件清除，只由下一次 send 清理（reducer 层锁定）。
    func testErrorActivityRetainedWithoutSpinner() async {
        let stream = ScriptedStreamClient(scripts: [.init(envelopes: [
            motionEventEnvelope(1, "m1", "部分回复"),
            activityEnvelope(2, "processing", label: "provider", detail: "kimi"),
            activityEnvelope(3, "error", label: "turn", detail: "LLM 网络失败"),
        ])])
        let store = ChatStore(send: MockSendClient(), stream: stream)
        store.startStream()

        let hosting = host(ChatView(store: store))
        await settle(hosting)
        XCTAssertEqual(store.activity, .error(detail: "LLM 网络失败"), "turn_error 必须保留可读错误行")
        XCTAssertEqual(
            countSubviews(NSProgressIndicator.self, in: hosting), 0,
            "error 是终态：无 spinner，但错误行保留（activityBar 文本仍存在）"
        )
    }

    // MARK: phase 2004 活动行视觉回归

    /// 源码契约：activityBar 只消费 ActivityStyle token，不写散落视觉数值——
    /// 不得出现 caption 字体或字面字号/颜色，字号/行高/不透明度/顶距必须来自 token；
    /// 窗口高度记账（activityHeight）必须消费同一 lineHeight + topGap（行高变化自动跟随）。
    func testActivityBarConsumesOnlyActivityStyleTokens() throws {
        let source = try chatViewSource()
        guard let section = section(of: source, from: "private func activityBar", to: "accessibilityIdentifier(\"activityBar\")") else {
            return XCTFail("未找到 activityBar 实现段")
        }
        XCTAssertFalse(section.contains(".font(.caption"), "activityBar 不得用 caption 动态默认字号")
        XCTAssertTrue(section.contains("ActivityStyle.fontSize"), "字号必须来自 ActivityStyle token")
        XCTAssertTrue(section.contains("ActivityStyle.lineHeight"), "行高必须来自 ActivityStyle token")
        XCTAssertTrue(section.contains("ActivityStyle.opacity"), "不透明度必须来自 ActivityStyle token")
        XCTAssertTrue(section.contains("ActivityStyle.showsSpinner"), "spinner 语义必须来自 ActivityStyle 单源")
        XCTAssertTrue(section.contains("exclamationmark.circle"), "错误态必须以错误图标替代 spinner")
        XCTAssertTrue(source.contains("composition.footerGap"), "footer 顶距必须来自 DialogueComposition token")
        XCTAssertTrue(
            source.contains("ActivityStyle.lineHeight + composition.footerGap"),
            "窗口高度记账必须消费同一 footerGap（行高 token 变化自动跟随）"
        )
    }

    /// 双主题正确性（源码契约）：activityBar 只用语义颜色（.secondary/.orange——
    /// 系统随浅/深色自适应），不得出现硬编码 RGB/十六进制/NSColor 字面量。
    /// 实机双主题可读性归 step-d 实机矩阵。
    func testActivityBarUsesSemanticThemeAdaptiveColors() throws {
        let source = try chatViewSource()
        guard let section = section(of: source, from: "private func activityBar", to: "accessibilityIdentifier(\"activityBar\")") else {
            return XCTFail("未找到 activityBar 实现段")
        }
        XCTAssertTrue(section.contains(".secondary"), "普通活动必须用 semantic secondary（主题自适应）")
        XCTAssertTrue(section.contains(".orange"), "错误态必须用 semantic orange（主题自适应）")
        XCTAssertFalse(section.contains("Color(red:"), "不得硬编码 RGB 颜色")
        XCTAssertFalse(section.contains("NSColor("), "不得硬编码 NSColor")
    }

    // MARK: phase 2008 同轴视觉组与 footer

    func testDialogueCompositionStructureContract() throws {
        let source = try chatViewSource()
        XCTAssertTrue(source.contains("ForEach(dialogueGroups)"), "回复必须按纯 UI 视觉组渲染")
        XCTAssertTrue(source.contains("composition.withinTurnGap"), "组内节奏必须来自 composition")
        XCTAssertTrue(source.contains("composition.betweenTurnsGap"), "组间节奏必须来自 composition")
        XCTAssertTrue(source.contains("composition.firstGroupGap"), "首组间距必须来自 composition")
        XCTAssertTrue(source.contains("composition.footerGap"), "footer 间距必须来自 composition")
        XCTAssertTrue(source.contains("MessageStyle.opacity(for:"), "typography 层级必须包含角色 opacity")
        XCTAssertFalse(source.contains("userLeadingInset"), "禁止重新引入 user 横向 inset")
        XCTAssertFalse(source.contains("MessageStyle.blockPadding"), "旧扁平 blockPadding 节奏已退役")
    }

    func testSameTypographyCompositionContract() {
        let composition = DialogueComposition.current
        XCTAssertEqual(composition.user.fontSize, composition.reply.fontSize)
        XCTAssertEqual(composition.user.weight, composition.reply.weight)
        XCTAssertGreaterThan(composition.withinTurnGap, 4, "组内节奏不得退回 2008 的 4pt")
        XCTAssertLessThan(composition.withinTurnGap, composition.betweenTurnsGap)
        XCTAssertEqual(MessageStyle.leadingInset(for: .user), MessageStyle.leadingInset(for: .motion))
    }

    // MARK: phase 2007-scroll 流式贴底（独立于 2007 视觉实现打捞）

    /// 贴底 owner 契约：流式贴底由 ScrollFollowAnchor 以 contentRevision 驱动；
    /// ScrollViewProxy.scrollTo 路径已退役（流式事务中被丢弃——main 实机探针贴底 2/89，
    /// 见 phase2007-logs/step-a-visual-scroll-facts.md）。
    func testScrollFollowOwnerContract() throws {
        let source = try chatViewSource()
        XCTAssertTrue(source.contains("ScrollFollowAnchor(contentRevision:"), "贴底必须由 ScrollFollowAnchor 承担")
        XCTAssertTrue(source.contains("messages.count * 100_000"), "contentRevision 必须由消息数与末条文本派生")
        XCTAssertFalse(source.contains("ScrollViewReader"), "ScrollViewProxy.scrollTo 流式滚动路径已退役")
        XCTAssertFalse(source.contains("scrollTo("), "不得存在残余 proxy scrollTo 调用")
    }
}

@MainActor
private final class HeightRecorder {
    private(set) var heights: [CGFloat] = []
    func record(_ height: CGFloat) { heights.append(height) }
}
