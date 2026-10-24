import Foundation

/// send ack：只表示 chestnut inbox 已接收该消息，不表示 Motion 已回复。
public struct SendAck: Equatable, Sendable {
    public let requestId: RequestId
    public let accepted: Bool
    public let detail: String?

    public init(requestId: RequestId, accepted: Bool, detail: String? = nil) {
        self.requestId = requestId
        self.accepted = accepted
        self.detail = detail
    }
}

/// 子进程完整结果的三态：正常接受 / 显式拒绝 / 异常终止。
public enum ProcessOutcome<T: Sendable>: Sendable {
    case accepted(T)
    case rejected(ChatError)
    case terminated(code: Int32?, signal: Int32?)
}

/// 一次性子进程的收集结果。stdout 按行、stderr 全文只作诊断。
public struct ProcessOutput: Equatable, Sendable {
    public let stdoutLines: [String]
    public let stderr: String
    public let exitCode: Int32
    public let terminationSignal: Int32?

    public init(stdoutLines: [String], stderr: String, exitCode: Int32, terminationSignal: Int32?) {
        self.stdoutLines = stdoutLines
        self.stderr = stderr
        self.exitCode = exitCode
        self.terminationSignal = terminationSignal
    }
}

/// 平台进程 capability：core 的 send/stream client 只依赖本协议；
/// macOS 由 Process 实现（MacOSChestnutProcess），Windows/Linux 未来各自实现。
public protocol ChestnutProcess: Sendable {
    /// 一次性运行：收集 stdout 行、stderr 全文与退出状态。启动失败抛 ChatError.transport。
    func run(_ argv: [String]) async throws -> ProcessOutput
    /// 长驻运行：逐行产出 stdout；进程结束关闭流（非零退出以 ChatError 结束）。
    func stream(_ argv: [String]) -> AsyncThrowingStream<String, Error>
    /// single-flight 停止当前长驻进程；无运行中进程时 no-op；重复调用安全。
    func stop() async
}

/// 发送 capability（一次性进程语义）。实现方必须等待 stdout 结果与进程终止的完整结果。
public protocol SendClient: Sendable {
    func submit(requestId: RequestId, text: String) async throws -> SendAck
}

/// 订阅 capability（长驻进程语义）。fromSequence 请求缺口恢复；
/// 当前 CLI 无序号恢复入口，实现方 fail closed，不伪造恢复成功。
public protocol StreamClient: Sendable {
    func events(fromSequence: Int?) -> AsyncThrowingStream<LauncherEnvelope, Error>
    func stop() async
}

/// 结构化 error envelope → ChatError 映射（class 字段为 Step C 协议决策的 fixture 形状）。
public enum WireErrorMapper {
    public static func map(_ envelope: LauncherEnvelope) -> ChatError {
        let classRaw = envelope.payload["class"]?.stringValue ?? "unknown"
        let detail = envelope.payload["detail"]?.stringValue ?? classRaw
        switch classRaw {
        case "daemon_stopped", "daemon_unavailable": return .daemon(detail: detail)
        case "rejected": return .rejected(detail: detail)
        case "protocol_mismatch": return .protocolMismatch(detail: detail)
        case "local": return .local(detail: detail)
        default: return .transport(detail: "error envelope class '\(classRaw)': \(detail)")
        }
    }
}

/// send 一次性进程适配：argvPrefix + [text]，等待 stdout 结果与进程终止的完整结果。
/// ack 只表示 inbox 接收；stdout 人类行只作诊断，只有版本化 envelope 才作协议数据。
public struct ChestnutSendClient: SendClient {
    private let process: any ChestnutProcess
    private let argvPrefix: [String]
    private let decoder: JsonlWireDecoder

    public init(process: any ChestnutProcess, argvPrefix: [String], decoder: JsonlWireDecoder = JsonlWireDecoder()) {
        self.process = process
        self.argvPrefix = argvPrefix
        self.decoder = decoder
    }

    public func submit(requestId: RequestId, text: String) async throws -> SendAck {
        let output: ProcessOutput
        do {
            // --request-id 由 chestnut ack envelope 原样回带（phase 1990 协议闭环）。
            output = try await process.run(argvPrefix + ["--request-id", requestId, text])
        } catch let error as ChatError {
            throw error
        } catch {
            throw ChatError.transport(detail: "send process failed: \(error.localizedDescription)")
        }
        switch Self.evaluate(output: output, requestId: requestId, decoder: decoder) {
        case .accepted(let ack):
            return ack
        case .rejected(let error):
            throw error
        case let .terminated(code, signal):
            throw ChatError.transport(
                detail: "send terminated unexpectedly (code: \(code.map(String.init) ?? "nil"), signal: \(signal.map(String.init) ?? "nil"))"
            )
        }
    }

    /// 结果评估顺序：结构化 error envelope > 信号终止 > 非零退出 > ack envelope。
    static func evaluate(output: ProcessOutput, requestId: RequestId, decoder: JsonlWireDecoder) -> ProcessOutcome<SendAck> {
        var ackEnvelope: LauncherEnvelope?
        for line in output.stdoutLines {
            guard let envelope = try? decoder.decode(line: line) else { continue }
            if envelope.kind == .error {
                return .rejected(WireErrorMapper.map(envelope))
            }
            if envelope.kind == .ack {
                ackEnvelope = envelope
            }
        }
        if let signal = output.terminationSignal {
            return .terminated(code: nil, signal: signal)
        }
        if output.exitCode != 0 {
            let detail = output.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return .rejected(.rejected(detail: detail.isEmpty ? "exit \(output.exitCode)" : detail))
        }
        if let ack = ackEnvelope, let ackRequestId = ack.payload["requestId"]?.stringValue, ackRequestId != requestId {
            return .rejected(.protocolMismatch(detail: "ack requestId mismatch: expected \(requestId), got \(ackRequestId)"))
        }
        // exit 0 = inbox 已接收；phase 1990 起 ack envelope 为协议要求，缺失说明对端是旧版 CLI
        return .accepted(SendAck(
            requestId: requestId,
            accepted: true,
            detail: ackEnvelope == nil ? "ack envelope missing (pre-1990 CLI)" : nil
        ))
    }
}

/// stream 长驻进程适配：逐行解码、single-flight、EOF/terminal/取消语义明确。
public actor ChestnutStreamClient: StreamClient {
    private let process: any ChestnutProcess
    private let argvPrefix: [String]
    private let decoder: JsonlWireDecoder
    private var running = false
    private var stopRequested = false

    public init(process: any ChestnutProcess, argvPrefix: [String], decoder: JsonlWireDecoder = JsonlWireDecoder()) {
        self.process = process
        self.argvPrefix = argvPrefix
        self.decoder = decoder
    }

    public nonisolated func events(fromSequence: Int?) -> AsyncThrowingStream<LauncherEnvelope, Error> {
        AsyncThrowingStream { continuation in
            Task { await self.run(fromSequence: fromSequence, continuation: continuation) }
        }
    }

    public func stop() async {
        stopRequested = true
        await process.stop()
    }

    private func run(
        fromSequence: Int?,
        continuation: AsyncThrowingStream<LauncherEnvelope, Error>.Continuation
    ) async {
        guard !running else {
            continuation.finish(throwing: ChatError.local(detail: "stream already running"))
            return
        }
        running = true
        stopRequested = false
        defer { running = false }

        // 缺口锁死：当前 CLI 无序号恢复入口，resync 请求 fail closed、不伪造恢复成功
        if let fromSequence {
            continuation.finish(throwing: ChatError.protocolMismatch(
                detail: "resync from sequence \(fromSequence) requires chestnut.launcher.v1 support (pending CLI-PROTOCOL-LAUNCHER-EXTERNAL-WIRE)"
            ))
            return
        }

        var sawTerminal = false
        do {
            for try await line in process.stream(argvPrefix) {
                if stopRequested { break }
                let envelope = try decoder.decode(line: line)
                switch envelope.kind {
                case .error:
                    throw WireErrorMapper.map(envelope)
                case .terminal:
                    sawTerminal = true
                    continuation.yield(envelope)
                default:
                    continuation.yield(envelope)
                }
            }
            if stopRequested || sawTerminal {
                continuation.finish()
            } else {
                continuation.finish(throwing: ChatError.transport(detail: "stream EOF before terminal event"))
            }
        } catch let error as ChatError {
            continuation.finish(throwing: error)
        } catch {
            continuation.finish(throwing: ChatError.transport(detail: "stream failed: \(error.localizedDescription)"))
        }
    }
}
