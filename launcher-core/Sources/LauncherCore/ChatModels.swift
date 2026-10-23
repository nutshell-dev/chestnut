import Foundation

/// 本地请求 ID：launcher 生成、chestnut ack 前只用于关联本地 sending 状态；
/// 不是 chestnut 事实 ID（当前 CLI 不接收 requestId，缺口见 drift CLI-PROTOCOL-LAUNCHER-EXTERNAL-WIRE）。
public typealias RequestId = String

/// 时间线消息。committed = true 表示已由 chestnut 事实确认（send ack 或 stream event）；
/// committed = false 仅本地降级展示（如未知事件类型），不是聊天事实。
public struct Message: Identifiable, Equatable, Sendable {
    public enum Role: String, Equatable, Sendable {
        case user
        case motion
        case system
    }

    public let id: String
    public let role: Role
    public let text: String
    public let committed: Bool

    public init(id: String, role: Role, text: String, committed: Bool) {
        self.id = id
        self.role = role
        self.text = text
        self.committed = committed
    }
}

/// UI 聊天状态机。draft 守恒：sending/degraded 都保留未 ack 草稿，
/// 只有 sendAccepted 才清草稿；窗口关闭不触碰状态。
public enum ChatState: Equatable, Sendable {
    case idle(draft: String, messages: [Message])
    case sending(draft: String, requestId: RequestId, messages: [Message])
    case degraded(draft: String, messages: [Message], error: ChatError)

    public var draft: String {
        switch self {
        case let .idle(draft, _): return draft
        case let .sending(draft, _, _): return draft
        case let .degraded(draft, _, _): return draft
        }
    }

    public var messages: [Message] {
        switch self {
        case let .idle(_, messages): return messages
        case let .sending(_, _, messages): return messages
        case let .degraded(_, messages, _): return messages
        }
    }

    /// 追加消息并保持当前 case 不变（stream event 在 sending 期间也可到达）。
    public func appending(_ message: Message) -> ChatState {
        switch self {
        case let .idle(draft, messages):
            return .idle(draft: draft, messages: messages + [message])
        case let .sending(draft, requestId, messages):
            return .sending(draft: draft, requestId: requestId, messages: messages + [message])
        case let .degraded(draft, messages, error):
            return .degraded(draft: draft, messages: messages + [message], error: error)
        }
    }
}
