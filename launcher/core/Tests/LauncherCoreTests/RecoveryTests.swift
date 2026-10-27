import Foundation
import XCTest
@testable import LauncherCore

/// Step D：失败恢复语义——send/stream 适配层对 ack、EOF、非零退出、daemon stopped、
/// resync、取消和重复 stop 的处理。fixture 为内存 fake，不触碰真实进程/凭据/daemon。
final class RecoveryTests: XCTestCase {
    private func envelopeLine(_ kind: String, sequence: Int, payload: String = "{}") -> String {
        """
        {"protocol":"chestnut.launcher.v2","sequence":\(sequence),"kind":"\(kind)","payload":\(payload)}
        """
    }

    // MARK: send

    func testSendAcceptedWithAckEnvelope() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(
                stdoutLines: [self.envelopeLine("send_ack", sequence: 1, payload: #"{"requestId":"r1"}"#)],
                stderr: "",
                exitCode: 0,
                terminationSignal: nil
            ))
        }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        let ack = try await client.submit(requestId: "r1", text: "hi")
        XCTAssertTrue(ack.accepted)
        XCTAssertEqual(ack.requestId, "r1")
        XCTAssertNil(ack.detail)
        // phase 1990：submit 把 requestId 经 --request-id 传给 CLI，ack envelope 回带校验
        XCTAssertEqual(process.runArgv, [["send", "--request-id", "r1", "hi"]])
    }

    func testSendAcceptedWithoutAckEnvelopeLocksTheGap() async throws {
        // 旧版 CLI 无 ack envelope：exit 0 = inbox 已收，但必须显式标注、不冒充协议成功
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(stdoutLines: ["Delivered to inbox"], stderr: "", exitCode: 0, terminationSignal: nil))
        }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        let ack = try await client.submit(requestId: "r1", text: "hi")
        XCTAssertTrue(ack.accepted)
        XCTAssertEqual(ack.detail, "ack envelope missing (pre-1990 CLI)")
    }

    func testLauncherV2SendUsesStdinAndReportsDeliveryAndDaemon() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(
                stdoutLines: [self.envelopeLine("send_ack", sequence: 1, payload: #"{"requestId":"r1","delivery":"persisted","daemon":"stopped"}"#)],
                stderr: "", exitCode: 0, terminationSignal: nil
            ))
        }
        let client = ChestnutLauncherSendClient(process: process, argv: ["launcher", "send", "--json"])
        let ack = try await client.submit(requestId: "r1", text: "ping")
        XCTAssertTrue(ack.accepted)
        XCTAssertEqual(ack.delivery, .persisted)
        XCTAssertEqual(ack.daemon, .stopped)
        XCTAssertEqual(process.runArgv, [["launcher", "send", "--json"]])
        XCTAssertEqual(process.runStdin.count, 1)
        XCTAssertTrue(process.runStdin[0]?.contains("\"text\":\"ping\"") == true)
        XCTAssertFalse(process.runArgv.flatMap { $0 }.contains("ping"))
    }

    func testSendNonZeroExitWithStderrIsRejected() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(stdoutLines: [], stderr: "claw not found\n", exitCode: 1, terminationSignal: nil))
        }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        do {
            _ = try await client.submit(requestId: "r1", text: "hi")
            XCTFail("expected rejection")
        } catch let error as ChatError {
            guard case let .rejected(detail) = error else {
                return XCTFail("expected rejected, got \(error)")
            }
            XCTAssertTrue(detail.contains("claw not found"))
            // phase 2004：Swift 本地生成错误 detail 为本地纯文本，不做 claw bar 格式化
            XCTAssertEqual(detail, "claw not found")
        }
    }

    func testSendDaemonStoppedEnvelopeMapsToDaemonError() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(
                stdoutLines: [self.envelopeLine("error", sequence: 1, payload: #"{"class":"daemon_stopped","detail":"motion daemon not running"}"#)],
                stderr: "",
                exitCode: 0,
                terminationSignal: nil
            ))
        }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        do {
            _ = try await client.submit(requestId: "r1", text: "hi")
            XCTFail("expected daemon error")
        } catch let error as ChatError {
            guard case let .daemon(detail) = error else {
                return XCTFail("expected daemon, got \(error)")
            }
            XCTAssertTrue(detail.contains("motion daemon not running"))
        }
    }

    // MARK: phase 2003 Step F 错误 detail 统一

    /// CLI error envelope 的 detail 已由 CLI 侧 claw bar formatter 格式化（含 [id] ✗ 前缀），
    /// WireErrorMapper 原样通过，Swift 不得重复包装（双重前缀 = 漂移）。
    func testCliFormattedErrorEnvelopePassesThroughUnwrapped() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in
            FakeStreamScript(lines: [
                self.envelopeLine("error", sequence: 1, payload: #"{"class":"daemon_stopped","detail":"[motion] ✗ daemon stopped"}"#),
            ])
        }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        do {
            for try await _ in client.events(fromSequence: nil) {}
            XCTFail("expected daemon error")
        } catch let error as ChatError {
            guard case let .daemon(detail) = error else {
                return XCTFail("expected daemon, got \(error)")
            }
            XCTAssertEqual(detail, "[motion] ✗ daemon stopped", "CLI 已格式化的 detail 原样通过，不重复包装")
        }
    }

    /// Swift 本地生成错误（协议失败/本地错误）detail 为本地纯文本：
    /// 不伪装 claw bar 形状（无前缀、无符号），格式化只存在于 TS 协议输出（phase 2004）。
    func testSwiftGeneratedErrorsStayPlainLocalText() async throws {
        // protocolMismatch：非协议行混入 stdout
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in FakeStreamScript(lines: ["not json at all"]) }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        do {
            for try await _ in client.events(fromSequence: nil) {}
            XCTFail("expected protocol error")
        } catch let error as ChatError {
            guard case let .protocolMismatch(detail) = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
            XCTAssertFalse(detail.hasPrefix("["), "Swift 本地错误不得伪装 claw bar 前缀，实际: \(detail)")
        }
    }

    func testSendAckRequestIdMismatchIsProtocolError() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(
                stdoutLines: [self.envelopeLine("send_ack", sequence: 1, payload: #"{"requestId":"other"}"#)],
                stderr: "",
                exitCode: 0,
                terminationSignal: nil
            ))
        }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        do {
            _ = try await client.submit(requestId: "r1", text: "hi")
            XCTFail("expected protocol error")
        } catch let error as ChatError {
            guard case .protocolMismatch = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
        }
    }

    func testSendSignalTerminationIsTransport() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in
            .success(ProcessOutput(stdoutLines: [], stderr: "", exitCode: 0, terminationSignal: 9))
        }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        do {
            _ = try await client.submit(requestId: "r1", text: "hi")
            XCTFail("expected transport error")
        } catch let error as ChatError {
            guard case .transport = error else {
                return XCTFail("expected transport, got \(error)")
            }
        }
    }

    func testSendLaunchFailureIsTransport() async throws {
        let process = FakeChestnutProcess()
        process.runHandler = { _ in .failure(ChatError.transport(detail: "launch failed")) }
        let client = ChestnutSendClient(process: process, argvPrefix: ["send"])
        do {
            _ = try await client.submit(requestId: "r1", text: "hi")
            XCTFail("expected transport error")
        } catch let error as ChatError {
            guard case .transport = error else {
                return XCTFail("expected transport, got \(error)")
            }
        }
    }

    // MARK: stream

    func testStreamDeliversEventsAndTerminalFinishesClean() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in
            FakeStreamScript(lines: [
                self.envelopeLine("message", sequence: 1, payload: #"{"messageId":"m1","text":"hi"}"#),
                self.envelopeLine("terminal", sequence: 2),
            ])
        }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        var envelopes: [LauncherEnvelope] = []
        for try await envelope in client.events(fromSequence: nil) {
            envelopes.append(envelope)
        }
        XCTAssertEqual(envelopes.map(\.kind), [.event, .terminal])
    }

    func testStreamEOFBeforeTerminalIsTransportError() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in
            FakeStreamScript(lines: [self.envelopeLine("message", sequence: 1)])
        }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        do {
            for try await _ in client.events(fromSequence: nil) {}
            XCTFail("expected EOF transport error")
        } catch let error as ChatError {
            guard case let .transport(detail) = error else {
                return XCTFail("expected transport, got \(error)")
            }
            // phase 2004：Swift 本地生成错误 detail 为本地纯文本，不做 claw bar 格式化
            XCTAssertEqual(detail, "stream EOF before terminal event")
        }
    }

    func testStreamMalformedLineIsProtocolError() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in FakeStreamScript(lines: ["not json at all"]) }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        do {
            for try await _ in client.events(fromSequence: nil) {}
            XCTFail("expected protocol error")
        } catch let error as ChatError {
            guard case .protocolMismatch = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
        }
    }

    func testStreamDaemonStoppedEnvelopeMapsToDaemonError() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in
            FakeStreamScript(lines: [
                self.envelopeLine("error", sequence: 1, payload: #"{"class":"daemon_stopped","detail":"gone"}"#),
            ])
        }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        do {
            for try await _ in client.events(fromSequence: nil) {}
            XCTFail("expected daemon error")
        } catch let error as ChatError {
            guard case let .daemon(detail) = error else {
                return XCTFail("expected daemon, got \(error)")
            }
            XCTAssertTrue(detail.contains("gone"))
        }
    }

    func testStreamResyncRequestsSnapshotAfterSequence() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in FakeStreamScript(lines: [
            self.envelopeLine("snapshot", sequence: 1, payload: #"{"afterSequence":42,"resync":"resync_required","messages":[]}"#),
            self.envelopeLine("terminal", sequence: 2),
        ]) }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        var kinds: [LauncherEnvelope.Kind] = []
        for try await envelope in client.events(fromSequence: 42) { kinds.append(envelope.kind) }
        XCTAssertEqual(kinds, [.snapshot, .terminal])
        XCTAssertEqual(process.streamArgv, [["stream", "--after-sequence", "42"]])
    }

    func testStreamIsSingleFlight() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in FakeStreamScript(lines: [], waitsForStop: true) }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])

        let first = client.events(fromSequence: nil)
        try await Task.sleep(nanoseconds: 50_000_000) // 让第一个订阅先进入 running
        let second = client.events(fromSequence: nil)
        do {
            for try await _ in second {}
            XCTFail("second subscription must be rejected")
        } catch let error as ChatError {
            guard case .local = error else {
                return XCTFail("expected local, got \(error)")
            }
        }
        await client.stop()
        for try await _ in first {}
        XCTAssertEqual(process.stopCalls, 1)
    }

    func testStreamStopIsIdempotentAndClean() async throws {
        let process = FakeChestnutProcess()
        process.streamHandler = { _ in FakeStreamScript(lines: [], waitsForStop: true) }
        let client = ChestnutStreamClient(process: process, argvPrefix: ["stream"])
        let stream = client.events(fromSequence: nil)
        var iterator = stream.makeAsyncIterator()
        try await Task.sleep(nanoseconds: 50_000_000)
        await client.stop()
        await client.stop() // 重复 stop 安全
        var thrown: Error?
        do {
            while let _ = try await iterator.next() {}
        } catch {
            thrown = error
        }
        XCTAssertNil(thrown, "用户主动 stop 不得表现为失败")
        XCTAssertEqual(process.stopCalls, 2)
    }

    // MARK: phase 2003 重开 bootstrap

    private func reopenEvent(_ seq: Int, _ messageId: String, _ text: String) -> LauncherEnvelope {
        LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: seq, sessionId: "s1", kind: .event,
            payload: .object(["messageId": .string(messageId), "role": .string("motion"), "text": .string(text)])
        )
    }

    private func reopenActivity(_ seq: Int, _ phase: String) -> LauncherEnvelope {
        LauncherEnvelope(
            protocolVersion: LauncherEnvelope.supportedProtocolVersion,
            sequence: seq, sessionId: "s1", kind: .activity,
            payload: .object(["phase": .string(phase)])
        )
    }

    /// 重开快照 → live tail：压缩快照（最终文本 + 最新 activity）按连号应用；
    /// 后续 live delta 同 messageId upsert 原位更新（不产生重复消息），sequence 连续。
    func testReopenSnapshotThenLiveTailUpsertsWithoutDuplicates() {
        var state = ChatCoreState()
        // current-turn 快照：reply-r1 最终文本 + 最新 activity（responding）
        state = ChatReducer.reduce(state, .streamEvent(reopenEvent(1, "reply-r1", "你好")))
        state = ChatReducer.reduce(state, .streamEvent(reopenActivity(2, "responding")))
        XCTAssertEqual(state.chat.messages.map { $0.text }, ["你好"])
        XCTAssertEqual(state.activity, .responding)
        // live：同 trace 继续 delta（producer 发累计快照）
        state = ChatReducer.reduce(state, .streamEvent(reopenEvent(3, "reply-r1", "你好呀")))
        XCTAssertEqual(state.chat.messages.count, 1, "重开后 live delta 不得产生重复消息")
        XCTAssertEqual(state.chat.messages[0].text, "你好呀")
        XCTAssertEqual(state.lastSequence, 3)
        XCTAssertNil(state.resyncPendingFrom)
    }
}

// MARK: - Fake process fixture

struct FakeStreamScript {
    var lines: [String]
    var error: Error?
    var waitsForStop: Bool

    init(lines: [String], error: Error? = nil, waitsForStop: Bool = false) {
        self.lines = lines
        self.error = error
        self.waitsForStop = waitsForStop
    }
}

final class FakeChestnutProcess: SetupChestnutProcess, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [AsyncThrowingStream<String, Error>.Continuation] = []

    var runHandler: (([String]) -> Result<ProcessOutput, Error>)?
    var streamHandler: (([String]) -> FakeStreamScript)?

    private(set) var runArgv: [[String]] = []
    private(set) var runStdin: [String?] = []
    private(set) var streamArgv: [[String]] = []
    private(set) var stopCalls = 0

    func run(_ argv: [String]) async throws -> ProcessOutput {
        let handler = lock.withLock { () -> (([String]) -> Result<ProcessOutput, Error>)? in
            runArgv.append(argv)
            return runHandler
        }
        guard let handler else { throw ChatError.local(detail: "no run handler") }
        return try handler(argv).get()
    }

    func run(_ argv: [String], stdin: String?) async throws -> ProcessOutput {
        lock.withLock { runStdin.append(stdin) }
        return try await run(argv)
    }

    func stream(_ argv: [String]) -> AsyncThrowingStream<String, Error> {
        lock.lock()
        streamArgv.append(argv)
        let handler = streamHandler
        lock.unlock()
        return AsyncThrowingStream { continuation in
            guard let handler else {
                continuation.finish()
                return
            }
            let script = handler(argv)
            for line in script.lines { continuation.yield(line) }
            if script.waitsForStop {
                self.lock.lock()
                self.pending.append(continuation)
                self.lock.unlock()
            } else {
                continuation.finish(throwing: script.error)
            }
        }
    }

    func stop() async {
        let pending = lock.withLock { () -> [AsyncThrowingStream<String, Error>.Continuation] in
            stopCalls += 1
            let pending = self.pending
            self.pending = []
            return pending
        }
        for continuation in pending { continuation.finish() }
    }
}
