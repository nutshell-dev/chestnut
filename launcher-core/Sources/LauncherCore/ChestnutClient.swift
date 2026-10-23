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
