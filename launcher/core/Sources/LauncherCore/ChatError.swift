import Foundation

/// launcher 失败类型（Phase 1982 Step C 语义，类型前置供 ChatState 使用）。
/// 五类归属：transport 传输层 / rejected chestnut 显式拒绝 / protocolMismatch 协议层 /
/// daemon daemon 不可用 / local launcher 本地错误。
public enum ChatError: Error, Equatable, Sendable {
    /// 进程启动失败、IO 错误、意外 EOF（terminal 前结束）、无结构化诊断的非零终止。
    case transport(detail: String)
    /// chestnut 显式拒绝：非零退出带 stderr 诊断，或结构化 error envelope class=rejected。
    case rejected(detail: String)
    /// 协议层：版本不匹配、malformed JSON、非协议行混入 stdout、ack requestId 不符。
    case protocolMismatch(detail: String)
    /// daemon 不可用：结构化 error envelope class=daemon_stopped / daemon_unavailable。
    case daemon(detail: String)
    /// launcher 本地错误：重复启动 stream、CLI 未配置等。
    case local(detail: String)

    /// 错误原始 detail（phase 2003 Step E）：UI 原样显示，不按类别拼接本地前缀——
    /// daemon/turn 错误的 detail 已由 CLI 侧 claw bar 共享 formatter 格式化。
    public var detail: String {
        switch self {
        case let .transport(detail): return detail
        case let .rejected(detail): return detail
        case let .protocolMismatch(detail): return detail
        case let .daemon(detail): return detail
        case let .local(detail): return detail
        }
    }

    /// phase 2003 Step F：把本错误归一化为 claw bar 可显示 detail——
    /// Swift 侧生成的错误（进程失败/协议失败/本地错误）detail 经 ClawBarErrorLine
    /// 格式化为 `[clawId] ✗ <单行 message>`；已携带 claw bar 形状的 detail（CLI error
    /// envelope 经 WireErrorMapper 进入，CLI 侧已格式化）不重复包装。
    public func withClawBarDetail(clawId: String) -> ChatError {
        let formatted = ClawBarErrorLine.format(clawId: clawId, message: detail)
        switch self {
        case .transport: return .transport(detail: formatted)
        case .rejected: return .rejected(detail: formatted)
        case .protocolMismatch: return .protocolMismatch(detail: formatted)
        case .daemon: return .daemon(detail: formatted)
        case .local: return .local(detail: formatted)
        }
    }
}

/// claw bar 普通错误行形状（phase 2003 Step F）：`[clawId] ✗ <单行 message>`。
/// 与 TS cli-protocol/claw-bar-display `formatClawBarError` 的 error 分支逐字节一致；
/// Swift 只复刻这一条规则（Swift 生成错误没有 CLI 格式化机会）——daemon/retry/blocked/
/// interrupted 等状态的格式化仍归 CLI 侧共享 formatter 单源，本类型不复刻、不成词典。
public enum ClawBarErrorLine {
    public static func format(clawId: String, message: String) -> String {
        "[\(clawId)] ✗ \(sanitize(message))"
    }

    /// 单行净化：换行/连续空白折为单个空格（与 TS sanitizeLine 同规则）。
    private static func sanitize(_ text: String) -> String {
        text.components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
