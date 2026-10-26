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
}
