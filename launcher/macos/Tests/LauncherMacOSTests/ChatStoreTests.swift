import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Step B：UI adapter 测试——draft 保留、ack 后清草稿、发送中锁草稿。
/// 使用 protocol mock 注入，不接真实 Chestnut 进程。
@MainActor
final class ChatStoreTests: XCTestCase {
    private func makeStore(
        send: any SendClient = MockSendClient(),
        stream: any StreamClient = MockStreamClient()
    ) -> ChatStore {
        var counter = 0
        return ChatStore(send: send, stream: stream, makeRequestId: {
            counter += 1
            return "req-\(counter)"
        })
    }

    func testDraftPublishesToState() {
        let store = makeStore()
        store.updateDraft("你好")
        XCTAssertEqual(store.state, .idle(draft: "你好", messages: []))
    }

    func testSubmitSuccessClearsDraftAndAppendsCommittedMessage() async {
        let store = makeStore()
        store.updateDraft("第一条")
        await store.submit()
        XCTAssertEqual(
            store.state,
            .idle(draft: "", messages: [Message(id: "req-1", role: .user, text: "第一条", committed: true)])
        )
    }

    func testSubmitEmptyDraftIsNoOp() async {
        let send = MockSendClient()
        let store = makeStore(send: send)
        await store.submit()
        XCTAssertEqual(store.state, .idle(draft: "", messages: []))
        XCTAssertEqual(send.submissions, 0, "空草稿不得发起 send")
    }

    func testSubmitFailureKeepsDraftAsDegraded() async {
        let send = MockSendClient(error: .rejected(detail: "exit 1"))
        let store = makeStore(send: send)
        store.updateDraft("别丢我")
        await store.submit()
        XCTAssertEqual(
            store.state,
            .degraded(draft: "别丢我", messages: [], error: .rejected(detail: "exit 1"))
        )
    }

    func testDraftLockedWhileSending() async {
        let gate = Gate()
        let send = MockSendClient(gate: gate)
        let store = makeStore(send: send)
        store.updateDraft("发送中")
        let submission = Task { await store.submit() }
        await gate.waitUntilEntered()
        // ack 前（sending 中）：编辑不生效、草稿保留
        store.updateDraft("改掉")
        XCTAssertEqual(store.state, .sending(draft: "发送中", requestId: "req-1", messages: []))
        await gate.release()
        await submission.value
        XCTAssertEqual(store.state.draft, "", "ack 后才清草稿")
    }

    func testDismissErrorKeepsDraft() async {
        let send = MockSendClient(error: .daemon(detail: "stopped"))
        let store = makeStore(send: send)
        store.updateDraft("重试我")
        await store.submit()
        store.dismissError()
        XCTAssertEqual(store.state, .idle(draft: "重试我", messages: []))
    }
}

// MARK: - Mocks

final class MockSendClient: SendClient, @unchecked Sendable {
    private(set) var submissions = 0
    private let error: ChatError?
    private let gate: Gate?

    init(error: ChatError? = nil, gate: Gate? = nil) {
        self.error = error
        self.gate = gate
    }

    func submit(requestId: RequestId, text: String) async throws -> SendAck {
        submissions += 1
        if let gate { await gate.waitUntilReleased() }
        if let error { throw error }
        return SendAck(requestId: requestId, accepted: true)
    }
}

final class MockStreamClient: StreamClient, @unchecked Sendable {
    private(set) var stopCalls = 0

    func events(fromSequence: Int?) -> AsyncThrowingStream<LauncherEnvelope, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish()
        }
    }

    func stop() async { stopCalls += 1 }
}

/// 测试门闩：让 send 挂在 ack 前，验证 sending 中间态。
final class Gate: @unchecked Sendable {
    private var entered = false
    private var released = false
    private let lock = NSLock()

    func waitUntilEntered() async {
        while true {
            if lock.withLock({ entered }) { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    func waitUntilReleased() async {
        lock.withLock { entered = true }
        while true {
            if lock.withLock({ released }) { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    func release() async {
        lock.withLock { released = true }
    }
}
