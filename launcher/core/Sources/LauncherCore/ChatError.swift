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

    /// 错误 detail（phase 2004）：UI 一律原样显示，Swift 不做任何格式化。
    /// - wire 携带的 detail（CLI error envelope / activity 错误族）是 TS 侧共享 formatter
    ///   输出的最终显示文本，Swift 只呈现、不改写；
    /// - Swift 本地生成的错误（进程失败/协议失败/本地错误）detail 是本地纯文本——
    ///   它们没有 TS 对应物，不伪装 claw bar 形状（phase 2003 Step F 的 Swift 侧规则
    ///   复刻已在 phase 2004 删除：协议输出最终文本，Swift 零格式知识）。
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
