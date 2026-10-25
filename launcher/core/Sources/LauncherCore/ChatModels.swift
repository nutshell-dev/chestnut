import Foundation

/// 本地请求 ID：launcher 生成；phase 1990 起经 `send --request-id` 传给 chestnut，
/// ack envelope 原样回带，consumer 校验对应关系。
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

/// Motion 活动状态（phase 2001 引入，phase 2002 增 error）：独立单行活动行的事实，不是聊天消息。
/// waiting 是本地态（send ack 前后、首个 stream 事件之前）；processing/responding/idle/error
/// 来自 activity envelope。idle 时 UI 完全不渲染活动行；error 保留可读错误行，
/// 直到下一次发送才清除（turn_error 不伪装 idle——网络/LLM 失败必须可见）。
public enum ActivityState: Equatable, Sendable {
    case idle
    case waiting
    case processing(label: String?, detail: String?)
    case responding
    case error(detail: String?)
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

    /// 用同 id 消息的最新快照替换原位（流式增量 upsert）；位置与其他消息不变。
    public func replacing(_ message: Message) -> ChatState {
        func replace(_ messages: [Message]) -> [Message] {
            var next = messages
            if let index = next.firstIndex(where: { $0.id == message.id }) {
                next[index] = message
            }
            return next
        }
        switch self {
        case let .idle(draft, messages):
            return .idle(draft: draft, messages: replace(messages))
        case let .sending(draft, requestId, messages):
            return .sending(draft: draft, requestId: requestId, messages: replace(messages))
        case let .degraded(draft, messages, error):
            return .degraded(draft: draft, messages: replace(messages), error: error)
        }
    }
}
