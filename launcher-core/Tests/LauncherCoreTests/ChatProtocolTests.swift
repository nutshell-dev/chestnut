import Foundation
import XCTest
@testable import LauncherCore

/// Step D：消息协议语义——envelope 与 ack/reply 区分、sequence 判定、unknown event 降级。
final class ChatProtocolTests: XCTestCase {
    private let decoder = JsonlWireDecoder()

    private func envelope(
        kind: LauncherEnvelope.Kind,
        sequence: Int,
        sessionId: String = "s1",
        payload: JSONValue = .null
    ) -> LauncherEnvelope {
        LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: sequence,
            sessionId: sessionId,
            kind: kind,
            payload: payload
        )
    }

    private func motionPayload(_ id: String, _ text: String) -> JSONValue {
        .object(["messageId": .string(id), "role": .string("motion"), "text": .string(text)])
    }

    // MARK: sequence 判定

    func testClassifySequence() {
        XCTAssertEqual(classifySequence(previous: 1, next: 2), .apply)
        XCTAssertEqual(classifySequence(previous: 2, next: 2), .duplicate)
        XCTAssertEqual(classifySequence(previous: 2, next: 1), .duplicate)
        XCTAssertEqual(classifySequence(previous: 1, next: 5), .resync(requiredFrom: 2))
    }

    // MARK: ack ≠ 回复

    func testAckEnvelopeDoesNotAppendMessage() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .ack, sequence: 1, payload: .object(["requestId": .string("r1")]))))
        XCTAssertEqual(state.chat.messages, [], "ack 只确认提交，不得追加 Motion 回复")
        XCTAssertEqual(state.lastSequence, 1)
    }

    func testTerminalEnvelopeDoesNotAppendMessage() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .terminal, sequence: 1)))
        XCTAssertEqual(state.chat.messages, [])
    }

    // MARK: event 追加与去重

    func testMotionEventAppendsCommittedMessage() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: motionPayload("m1", "你好"))))
        XCTAssertEqual(state.chat.messages, [Message(id: "m1", role: .motion, text: "你好", committed: true)])
    }

    func testEventWithoutMessagePayloadAdvancesSequenceOnly() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: .object(["type": .string("provider_info")]))))
        XCTAssertEqual(state.chat.messages, [])
        XCTAssertEqual(state.lastSequence, 1)
    }

    func testDuplicateSequenceNotReRendered() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: motionPayload("m1", "hi"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: motionPayload("m1", "hi"))))
        XCTAssertEqual(state.chat.messages.count, 1, "重复事件不重复渲染")
        XCTAssertEqual(state.lastSequence, 1)
    }

    /// phase 1990 流式增量：同 messageId 的后续 event 为累积快照，原位 upsert 更新文本，
    /// 消息数量不增长、其他消息与位置不变。
    func testSameMessageIdUpsertsLatestSnapshot() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: motionPayload("user-1", "问"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 2, payload: motionPayload("reply-t1", "你"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 3, payload: motionPayload("reply-t1", "你好"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 4, payload: motionPayload("reply-t1", "你好，世界"))))
        XCTAssertEqual(state.chat.messages.map(\.id), ["user-1", "reply-t1"])
        XCTAssertEqual(state.chat.messages[1].text, "你好，世界")
        XCTAssertEqual(state.lastSequence, 4)
    }

    // MARK: 跳号与 resync

    func testGapTriggersResyncAndKeepsMessagesAndDraft() {
        var state = ChatCoreState(chat: .idle(draft: "未发送", messages: []))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: motionPayload("m1", "a"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 5, payload: motionPayload("m5", "e"))))
        XCTAssertEqual(state.resyncPendingFrom, 2, "跳号必须触发 resync")
        XCTAssertEqual(state.lastSequence, 1, "跳号事件不应用")
        XCTAssertEqual(state.chat.messages.count, 1)
        XCTAssertEqual(state.chat.draft, "未发送", "resync 期间不清未确认草稿")
    }

    func testResyncEventAppliesAndClearsPending() {
        var state = ChatCoreState()
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 1, payload: motionPayload("m1", "a"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 5, payload: motionPayload("m5", "e"))))
        state = ChatReducer.reduce(state, .streamEvent(envelope(kind: .event, sequence: 2, payload: motionPayload("m2", "b"))))
        XCTAssertEqual(state.lastSequence, 2)
        XCTAssertNil(state.resyncPendingFrom)
        XCTAssertEqual(state.chat.messages.map(\.id), ["m1", "m2"])
    }

    // MARK: unknown event 降级

    func testUnknownKindDegradesToUncommittedSystemMessage() throws {
        let raw = #"{"protocolVersion":"chestnut.launcher.v1","sequence":1,"sessionId":"s1","kind":"telemetry_v2","payload":{"k":"v"}}"#
        let decoded = try decoder.decode(line: raw)
        let state = ChatReducer.reduce(ChatCoreState(), .streamEvent(decoded))
        guard let note = state.chat.messages.first else {
            return XCTFail("未知 kind 必须保留元数据降级展示")
        }
        XCTAssertEqual(note.role, .system)
        XCTAssertFalse(note.committed, "降级展示不是聊天事实")
        XCTAssertTrue(note.text.contains("telemetry_v2"))
    }

    // MARK: 版本与形状（decoder 侧补充）

    func testEnvelopeRoundTripFieldParity() throws {
        let raw = #"{"protocolVersion":"chestnut.launcher.v1","sequence":9,"sessionId":"sess","kind":"event","payload":{"messageId":"m9","text":"x"}}"#
        let envelope = try decoder.decode(line: raw)
        XCTAssertEqual(envelope, self.envelope(kind: .event, sequence: 9, sessionId: "sess", payload: .object(["messageId": .string("m9"), "text": .string("x")])))
    }
}
