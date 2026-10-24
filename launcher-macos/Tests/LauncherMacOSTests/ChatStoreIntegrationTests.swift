import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Step D：ChatStore + fake send/stream 的端到端状态转换。
/// 锁定 v0 语义：ack 不产生回复；重复不重复渲染；跳号 resync 不丢消息与草稿；
/// 断线保留已确认消息和未确认草稿；用户退出不显示为 daemon failure。
@MainActor
final class ChatStoreIntegrationTests: XCTestCase {
    private func makeEnvelope(
        _ kind: LauncherEnvelope.Kind,
        _ sequence: Int,
        payload: JSONValue = .null
    ) -> LauncherEnvelope {
        LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: sequence,
            sessionId: "s1",
            kind: kind,
            payload: payload
        )
    }

    private func motionPayload(_ id: String, _ text: String) -> JSONValue {
        .object(["messageId": .string(id), "role": .string("motion"), "text": .string(text)])
    }

    private func makeStore(
        send: any SendClient = MockSendClient(),
        stream: ScriptedStreamClient
    ) -> ChatStore {
        var counter = 0
        return ChatStore(send: send, stream: stream, makeRequestId: {
            counter += 1
            return "req-\(counter)"
        })
    }

    private func eventually(
        _ condition: @escaping () -> Bool,
        timeout: TimeInterval = 2,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "condition not met within \(timeout)s", file: file, line: line)
    }

    func testEndToEndAckDistinctFromReply() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(envelopes: [makeEnvelope(.event, 1, payload: motionPayload("m1", "你好，我是 Motion"))]),
        ])
        let send = MockSendClient()
        let store = makeStore(send: send, stream: stream)

        store.startStream()
        await eventually { store.state.messages.count == 1 }

        store.updateDraft("第一个问题")
        await store.submit()

        XCTAssertEqual(
            store.state.messages,
            [
                Message(id: "m1", role: .motion, text: "你好，我是 Motion", committed: true),
                Message(id: "req-1", role: .user, text: "第一个问题", committed: true),
            ],
            "send accepted 不追加 Motion 回复；Motion 消息只来自 stream event"
        )
        XCTAssertEqual(store.state.draft, "")
        XCTAssertEqual(stream.subscriptions, [nil])
    }

    /// phase 1990 Step D：真实闭环语义——同 messageId 的流式快照增量更新最后一条
    /// Motion 回复，而非新增重复 bubble；消息数量不增长。
    func testStreamDeltaUpdatesLastMotionMessage() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(envelopes: [
                makeEnvelope(.event, 1, payload: motionPayload("reply-t1", "你")),
                makeEnvelope(.event, 2, payload: motionPayload("reply-t1", "你好")),
                makeEnvelope(.event, 3, payload: motionPayload("reply-t1", "你好，世界")),
            ]),
        ])
        let store = makeStore(stream: stream)
        store.startStream()

        await eventually { store.state.messages.count == 1 && store.state.messages[0].text == "你好，世界" }

        XCTAssertEqual(store.state.messages.map(\.id), ["reply-t1"])
        XCTAssertEqual(store.state.messages.map(\.text), ["你好，世界"])
        XCTAssertEqual(store.snapshot.lastSequence, 3)
    }

    func testGapTriggersResyncWithoutLosingMessagesOrDraft() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(envelopes: [
                makeEnvelope(.event, 1, payload: motionPayload("m1", "a")),
                makeEnvelope(.event, 5, payload: motionPayload("m5", "e")), // 跳号
            ]),
            .init(envelopes: [
                makeEnvelope(.event, 2, payload: motionPayload("m2", "b")),
                makeEnvelope(.event, 3, payload: motionPayload("m3", "c")),
                makeEnvelope(.event, 4, payload: motionPayload("m4", "d")),
                makeEnvelope(.event, 5, payload: motionPayload("m5", "e")), // 重放尾部
            ]),
        ])
        let store = makeStore(stream: stream)
        store.updateDraft("resync 期间不丢我")
        store.startStream()

        await eventually { store.state.messages.count == 5 }

        XCTAssertEqual(store.state.messages.map(\.id), ["m1", "m2", "m3", "m4", "m5"])
        XCTAssertEqual(store.snapshot.lastSequence, 5)
        XCTAssertNil(store.snapshot.resyncPendingFrom)
        XCTAssertEqual(store.state.draft, "resync 期间不丢我", "resync 期间不清未确认草稿")
        XCTAssertEqual(stream.subscriptions, [nil, 2], "缺口后从 requiredFrom 恢复订阅")
        XCTAssertEqual(stream.stopCalls, 1)
    }

    func testStreamDisconnectKeepsCommittedMessagesAndUnackedDraft() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(
                envelopes: [makeEnvelope(.event, 1, payload: motionPayload("m1", "a"))],
                error: ChatError.transport(detail: "stream EOF before terminal event")
            ),
        ])
        let store = makeStore(stream: stream)
        store.startStream()
        await eventually { store.state.messages.count == 1 }

        store.updateDraft("断线前输入")
        await eventually {
            if case .degraded = store.state { return true }
            return false
        }

        guard case let .degraded(draft, messages, error) = store.state else {
            return XCTFail("断线必须进入 degraded")
        }
        XCTAssertEqual(draft, "断线前输入", "stream 断线不清未确认草稿")
        XCTAssertEqual(messages.map(\.id), ["m1"], "resync/断线不丢已确认消息")
        guard case .transport = error else {
            return XCTFail("expected transport, got \(error)")
        }
    }

    func testUserQuitStopsStreamWithoutFailure() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(envelopes: [makeEnvelope(.event, 1, payload: motionPayload("m1", "a"))]),
        ])
        let store = makeStore(stream: stream)
        store.startStream()
        await eventually { store.state.messages.count == 1 }

        await store.stopStream()
        await store.stopStream() // 重复 stop 安全

        if case .degraded = store.state {
            XCTFail("用户主动退出不得显示为 daemon failure")
        }
        XCTAssertEqual(store.state.messages.map(\.id), ["m1"])
        XCTAssertEqual(stream.stopCalls, 2)
    }
}

/// 脚本化 stream fake：按 events(fromSequence:) 调用顺序消费脚本，记录订阅参数。
final class ScriptedStreamClient: StreamClient, @unchecked Sendable {
    struct Script {
        var envelopes: [LauncherEnvelope]
        var error: Error?

        init(envelopes: [LauncherEnvelope], error: Error? = nil) {
            self.envelopes = envelopes
            self.error = error
        }
    }

    private let lock = NSLock()
    private var scripts: [Script]
    private(set) var subscriptions: [Int?] = []
    private(set) var stopCalls = 0

    init(scripts: [Script]) {
        self.scripts = scripts
    }

    func events(fromSequence: Int?) -> AsyncThrowingStream<LauncherEnvelope, Error> {
        lock.lock()
        subscriptions.append(fromSequence)
        let script = scripts.isEmpty ? Script(envelopes: []) : scripts.removeFirst()
        lock.unlock()
        return AsyncThrowingStream { continuation in
            for envelope in script.envelopes { continuation.yield(envelope) }
            continuation.finish(throwing: script.error)
        }
    }

    func stop() async {
        lock.withLock { stopCalls += 1 }
    }
}
