import Foundation
import XCTest
@testable import LauncherCore

/// Step B：平台无关状态机测试（send 路径与草稿守恒；stream 事件路径见 Step D）。
final class ChatReducerTests: XCTestCase {
    private let base = ChatCoreState()

    func testDraftChangedInIdle() {
        let next = ChatReducer.reduce(base, .draftChanged("你好"))
        XCTAssertEqual(next.chat, .idle(draft: "你好", messages: []))
    }

    func testDraftChangedInDegradedKeepsError() {
        let degraded = ChatCoreState(chat: .degraded(draft: "old", messages: [], error: .local(detail: "x")))
        let next = ChatReducer.reduce(degraded, .draftChanged("new"))
        XCTAssertEqual(next.chat, .degraded(draft: "new", messages: [], error: .local(detail: "x")))
    }

    func testSendStartedRequiresNonEmptyDraft() {
        let empty = ChatReducer.reduce(base, .sendStarted(requestId: "r1"))
        XCTAssertEqual(empty, base, "空草稿不得进入 sending")

        let drafted = ChatCoreState(chat: .idle(draft: "hi", messages: []))
        let sending = ChatReducer.reduce(drafted, .sendStarted(requestId: "r1"))
        XCTAssertEqual(sending.chat, .sending(draft: "hi", requestId: "r1", messages: []))
    }

    func testDraftLockedWhileSending() {
        let sending = ChatCoreState(chat: .sending(draft: "hi", requestId: "r1", messages: []))
        let next = ChatReducer.reduce(sending, .draftChanged("edited"))
        XCTAssertEqual(next, sending, "sending 期间编辑不生效，防止 ack 错配")
    }

    func testSendAcceptedAppendsCommittedUserMessageAndClearsDraft() {
        let prior = [Message(id: "m0", role: .motion, text: "旧消息", committed: true)]
        let sending = ChatCoreState(chat: .sending(draft: "hi", requestId: "r1", messages: prior))
        let next = ChatReducer.reduce(sending, .sendAccepted(requestId: "r1"))
        XCTAssertEqual(
            next.chat,
            .idle(draft: "", messages: prior + [Message(id: "r1", role: .user, text: "hi", committed: true)])
        )
    }

    func testSendAcceptedWithStaleRequestIdIgnored() {
        let sending = ChatCoreState(chat: .sending(draft: "hi", requestId: "r1", messages: []))
        let next = ChatReducer.reduce(sending, .sendAccepted(requestId: "stale"))
        XCTAssertEqual(next, sending, "requestId 不符的 ack 必须忽略")
    }

    func testSendFailedKeepsDraftAndMessages() {
        let prior = [Message(id: "m0", role: .motion, text: "旧消息", committed: true)]
        let sending = ChatCoreState(chat: .sending(draft: "hi", requestId: "r1", messages: prior))
        let error = ChatError.rejected(detail: "daemon offline")
        let next = ChatReducer.reduce(sending, .sendFailed(error))
        XCTAssertEqual(next.chat, .degraded(draft: "hi", messages: prior, error: error))
    }

    func testStreamFailedKeepsDraftAndMessages() {
        let prior = [Message(id: "m0", role: .motion, text: "旧消息", committed: true)]
        let idle = ChatCoreState(chat: .idle(draft: "未发送", messages: prior))
        let error = ChatError.transport(detail: "stream EOF before terminal event")
        let next = ChatReducer.reduce(idle, .streamFailed(error))
        XCTAssertEqual(next.chat, .degraded(draft: "未发送", messages: prior, error: error))
    }

    func testStreamStoppedByUserIsNotAFailure() {
        let idle = ChatCoreState(chat: .idle(draft: "未发送", messages: []))
        let next = ChatReducer.reduce(idle, .streamStoppedByUser)
        XCTAssertEqual(next, idle, "用户主动退出不得显示为 daemon failure")
    }

    func testErrorDismissedReturnsToIdleKeepingDraft() {
        let prior = [Message(id: "m0", role: .motion, text: "旧消息", committed: true)]
        let degraded = ChatCoreState(chat: .degraded(draft: "hi", messages: prior, error: .local(detail: "x")))
        let next = ChatReducer.reduce(degraded, .errorDismissed)
        XCTAssertEqual(next.chat, .idle(draft: "hi", messages: prior))
    }

    // MARK: phase 2001 活动行生命周期

    private func activityEnvelope(_ seq: Int, _ phase: String, label: String? = nil, detail: String? = nil) -> LauncherEnvelope {
        var payload: [String: JSONValue] = ["phase": .string(phase)]
        if let label { payload["label"] = .string(label) }
        if let detail { payload["detail"] = .string(detail) }
        return LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: seq, sessionId: "s1", kind: .activity, payload: .object(payload)
        )
    }

    /// 发送即反馈：sendStarted → waiting；sendAccepted 后保持 waiting（ack ≠ turn 开始）。
    func testSendStartsWaitingActivity() {
        var state = ChatCoreState(chat: .idle(draft: "hi", messages: []))
        state = ChatReducer.reduce(state, .sendStarted(requestId: "r1"))
        XCTAssertEqual(state.activity, .waiting, "发送后立即出现活动占位")
        state = ChatReducer.reduce(state, .sendAccepted(requestId: "r1"))
        XCTAssertEqual(state.activity, .waiting, "ack 只确认提交，活动行继续等待首个 stream 事件")
    }

    /// waiting → processing → responding →（send_content_end 仍 responding）→ idle 单调迁移。
    func testActivityLifecycleMonotonic() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(1, "processing", label: "turn")))
        XCTAssertEqual(state.activity, .processing(label: "turn", detail: nil))
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(2, "responding")))
        XCTAssertEqual(state.activity, .responding)
        // send_content_end 也映射 responding：不结束活动
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(3, "responding")))
        XCTAssertEqual(state.activity, .responding, "send_content_end 不得撤掉活动行")
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(4, "idle")))
        XCTAssertEqual(state.activity, .idle)
    }

    /// 乱序守卫：activity 事件早于 send ack 到达时，sendAccepted 不得把 processing 覆盖回 waiting。
    func testSendAcceptedDoesNotDowngradeProcessingToWaiting() {
        var state = ChatCoreState(chat: .idle(draft: "hi", messages: []))
        state = ChatReducer.reduce(state, .sendStarted(requestId: "r1"))
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(1, "processing", label: "llm")))
        XCTAssertEqual(state.activity, .processing(label: "llm", detail: nil))
        state = ChatReducer.reduce(state, .sendAccepted(requestId: "r1"))
        XCTAssertEqual(state.activity, .processing(label: "llm", detail: nil), "ack 晚到时不得回退活动状态")
    }

    /// 清理路径：sendFailed / streamFailed / terminal 都撤掉活动行（不常驻）。
    func testActivityClearedOnFailuresAndTerminal() {
        var sending = ChatCoreState(chat: .sending(draft: "hi", requestId: "r1", messages: []), activity: .waiting)
        sending = ChatReducer.reduce(sending, .sendFailed(.rejected(detail: "x")))
        XCTAssertEqual(sending.activity, .idle, "发送失败撤销 waiting 占位")

        var active = ChatCoreState(activity: .responding)
        active = ChatReducer.reduce(active, .streamFailed(.transport(detail: "EOF")))
        XCTAssertEqual(active.activity, .idle, "stream 断线兜底清理活动行")

        var terminalState = ChatCoreState(activity: .processing(label: "tool", detail: "search"))
        let terminal = LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: 1, sessionId: "s1", kind: .terminal, payload: .null
        )
        terminalState = ChatReducer.reduce(terminalState, .streamEvent(terminal))
        XCTAssertEqual(terminalState.activity, .idle, "stream terminal 兜底清理活动行")
    }

    /// 畸形 activity payload（未知 phase）只推进 sequence，不产生活动变更。
    func testMalformedActivityPayloadOnlyAdvancesSequence() {
        var state = ChatCoreState(activity: .responding)
        let bad = LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: 1, sessionId: "s1", kind: .activity, payload: .object(["phase": .string("exploding")])
        )
        state = ChatReducer.reduce(state, .streamEvent(bad))
        XCTAssertEqual(state.activity, .responding, "未知 activity phase 不得改变活动状态")
        XCTAssertEqual(state.lastSequence, 1)
    }

    /// activity 不产生聊天消息。
    func testActivityDoesNotAppendMessages() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(1, "processing", label: "tool")))
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(2, "idle")))
        XCTAssertEqual(state.chat.messages, [], "活动行不是聊天消息")
    }

    // MARK: phase 2002 error 保留与中间 send

    /// turn_error → error 保留可读错误行（不伪装 idle）；错误行不被 stream 后续无关事件静默清除。
    func testTurnErrorActivityRetained() {
        var state = ChatCoreState(activity: .processing(label: "provider", detail: "kimi"))
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(1, "error", label: "turn", detail: "LLM 网络失败 provider kimi 不可用")))
        XCTAssertEqual(state.activity, .error(detail: "LLM 网络失败 provider kimi 不可用"), "turn_error 必须保留可见错误行")
    }

    /// error 行只由下一次 sendStarted 清除并重新 waiting；sendAccepted 不回退。
    func testNextSendClearsErrorToWaiting() {
        var state = ChatCoreState(chat: .idle(draft: "重试", messages: []), activity: .error(detail: "LLM 网络失败"))
        state = ChatReducer.reduce(state, .sendStarted(requestId: "r2"))
        XCTAssertEqual(state.activity, .waiting, "下一次发送显式清除旧 error 并重新 waiting")
        state = ChatReducer.reduce(state, .sendAccepted(requestId: "r2"))
        XCTAssertEqual(state.activity, .waiting)
    }

    /// 中间 send 不清理活动：processing → responding（send）→ processing（继续工具/思考）保持非 idle。
    func testIntermediateSendDoesNotClearActivity() {
        var state = ChatCoreState(activity: .processing(label: "tool", detail: "run"))
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(1, "responding"))) // send
        XCTAssertTrue(state.activity != .idle, "中间 send 不得清理活动")
        state = ChatReducer.reduce(state, .streamEvent(activityEnvelope(2, "processing", label: "thinking", detail: "继续")))
        XCTAssertEqual(state.activity, .processing(label: "thinking", detail: "继续"))
    }
}
