import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Phase 2021：transport 观察恢复只重订阅，不进入 degraded、不清状态、不重发 send。
@MainActor
final class Phase2021RecoveryTests: XCTestCase {
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
        ChatStore(
            send: send,
            stream: stream,
            makeRequestId: { "req-1" },
            reconnectBackoff: { _ in 0 }
        )
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

    func testTransportEOFResubscribesFromLatestSequenceAndPreservesState() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(
                envelopes: [
                    makeEnvelope(.event, 1, payload: motionPayload("m1", "a")),
                    makeEnvelope(.activity, 2, payload: .object([
                        "phase": .string("processing"),
                        "label": .string("thinking"),
                    ])),
                ],
                error: ChatError.transport(detail: "stream EOF before terminal event")
            ),
            .init(envelopes: [
                makeEnvelope(.event, 3, payload: motionPayload("m2", "b")),
            ]),
        ])
        let send = MockSendClient()
        let store = makeStore(send: send, stream: stream)
        store.updateDraft("恢复期间不丢我")

        store.startStream()
        await eventually {
            stream.subscriptions.count == 2 && store.state.messages.map(\.id) == ["m1", "m2"]
        }

        XCTAssertEqual(stream.subscriptions, [nil, 2], "重订阅必须使用最近已应用序号")
        XCTAssertEqual(store.state.draft, "恢复期间不丢我")
        XCTAssertEqual(store.state.messages.map(\.id), ["m1", "m2"])
        XCTAssertEqual(store.activity, .processing(label: "thinking", detail: nil))
        XCTAssertEqual(store.snapshot.lastSequence, 3)
        XCTAssertEqual(send.submissions, 0, "观察恢复绝不重发 send")
        if case .degraded = store.state {
            XCTFail("可恢复 transport EOF 不得进入 degraded")
        }
    }

    func testDaemonStoppedTerminalDoesNotRetryAndAllowsLaterStart() async {
        let stream = ScriptedStreamClient(scripts: [
            .init(envelopes: [
                makeEnvelope(.daemon, 1, payload: .object(["state": .string("stopped")])),
                makeEnvelope(.terminal, 2, payload: .object(["reason": .string("daemon_stopped")])),
            ]),
            .init(envelopes: [
                makeEnvelope(.event, 3, payload: motionPayload("m3", "later")),
            ]),
        ])
        let store = makeStore(stream: stream)

        store.startStream()
        await eventually { store.snapshot.lastSequence == 2 }
        try? await Task.sleep(nanoseconds: 20_000_000)

        XCTAssertEqual(stream.subscriptions, [nil], "正常 terminal 不得自动重订阅")
        XCTAssertEqual(store.activity, .idle)

        // task 正常结束后清理 single-flight，再次 start 应从最近序号订阅。
        await eventually {
            store.startStream()
            return stream.subscriptions.count == 2
        }
        await eventually { store.state.messages.map(\.id) == ["m3"] }
        XCTAssertEqual(stream.subscriptions, [nil, 2])
    }

    func testNonTransportErrorsEnterDegradedWithoutRetry() async {
        let errors: [ChatError] = [
            .protocolMismatch(detail: "protocol"),
            .daemon(detail: "daemon"),
            .rejected(detail: "rejected"),
            .local(detail: "local"),
        ]

        for expected in errors {
            let stream = ScriptedStreamClient(scripts: [
                .init(envelopes: [], error: expected),
            ])
            let store = makeStore(stream: stream)
            store.startStream()

            await eventually {
                if case .degraded = store.state { return true }
                return false
            }
            guard case let .degraded(_, _, actual) = store.state else {
                XCTFail("expected degraded for \(expected)")
                continue
            }
            XCTAssertEqual(actual, expected)
            XCTAssertEqual(stream.subscriptions, [nil], "\(expected) 不得自动重订阅")
        }
    }
}
