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
}
