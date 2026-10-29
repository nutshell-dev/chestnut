import Foundation

/// core 完整状态：UI 聊天状态 + stream 订阅状态分离（send request 状态与
/// stream subscription 状态不混淆）。lastSequence/resyncPendingFrom 由 Step C 的
/// stream 事件路径维护。
public struct ChatCoreState: Equatable, Sendable {
    public var chat: ChatState
    /// 最近已应用的事件序号；nil = 尚未收到任何事件（首事件建立基线）。
    public var lastSequence: Int?
    /// 跳号后等待 resync 的起点序号；非 nil 期间不丢已确认消息与未确认草稿。
    public var resyncPendingFrom: Int?
    /// Motion 活动行状态（phase 2001）：独立于聊天消息，idle 时 UI 不渲染。
    public var activity: ActivityState

    public init(
        chat: ChatState = .idle(draft: "", messages: []),
        lastSequence: Int? = nil,
        resyncPendingFrom: Int? = nil,
        activity: ActivityState = .idle
    ) {
        self.chat = chat
        self.lastSequence = lastSequence
        self.resyncPendingFrom = resyncPendingFrom
        self.activity = activity
    }

}

/// UI/adapter 可派发的动作。streamEvent 由 Step C 加入（依赖 WireDecoder 的 envelope）。
public enum ChatAction: Equatable, Sendable {
    case draftChanged(String)
    case sendStarted(requestId: RequestId)
    case sendAccepted(requestId: RequestId)
    case sendFailed(ChatError)
    /// stream 断线/失败：保留已确认消息与未确认草稿，进入 degraded。
    case streamFailed(ChatError)
    /// stream 事件到达：按 sequence 判定 apply/duplicate/resync。
    case streamEvent(LauncherEnvelope)
    /// 用户主动退出停止订阅：不伪造业务失败、不改状态。
    case streamStoppedByUser
    /// 用户关闭错误提示：degraded → idle，草稿与消息保留。
    case errorDismissed
}

/// 平台无关状态机。纯函数：不创建窗口、不创建进程、不做 IO。
public enum ChatReducer {
    public static func reduce(_ state: ChatCoreState, _ action: ChatAction) -> ChatCoreState {
        var next = state
        switch action {
        case let .draftChanged(text):
            switch state.chat {
            case let .idle(_, messages):
                next.chat = .idle(draft: text, messages: messages)
            case let .degraded(_, messages, error):
                next.chat = .degraded(draft: text, messages: messages, error: error)
            case .sending:
                break // 发送中锁草稿：ack 前编辑不生效，避免 ack 错配
            }
        case let .sendStarted(requestId):
            guard case let .idle(draft, messages) = state.chat, !draft.isEmpty else { break }
            next.chat = .sending(draft: draft, requestId: requestId, messages: messages)
            // 发送即给反馈（phase 2001）：无活动时进入 waiting；
            // 已有 processing/responding（上个 turn 未结束）不回退。
            // phase 2002：旧 error 行由下一次发送显式清除并重新 waiting。
            // phase 2003 Step F：interrupted/retry/blocked 同属错误族，同样由下一次发送清除。
            switch state.activity {
            case .idle, .error, .interrupted, .retry, .blocked: next.activity = .waiting
            default: break
            }
        case let .sendAccepted(requestId):
            // ack 只确认提交成功：追加用户消息、清草稿；不产生 Motion 回复。
            // requestId 不符 = 过期 ack，忽略。
            // activity 保持 waiting（ack ≠ turn 开始）；若 stream 事件已先行到达
            // （乱序），不得把 processing/responding 覆盖回 waiting。
            guard case let .sending(draft, currentId, messages) = state.chat, currentId == requestId else { break }
            next.chat = .idle(
                draft: "",
                messages: messages + [Message(id: requestId, role: .user, text: draft, committed: true)]
            )
        case let .sendFailed(error):
            // 失败保留草稿与既有消息，交用户决定重试；不自动重发。
            guard case let .sending(draft, _, messages) = state.chat else { break }
            next.chat = .degraded(draft: draft, messages: messages, error: error)
            next.activity = .idle // 发送未成立，撤销 waiting 占位
        case let .streamFailed(error):
            next.chat = .degraded(draft: state.chat.draft, messages: state.chat.messages, error: error)
            next.activity = .idle // stream 断线兜底清理活动行，不常驻
        case let .streamEvent(envelope):
            applyStreamEvent(envelope, to: &next)
        case .streamStoppedByUser:
            break
        case .errorDismissed:
            if case let .degraded(draft, messages, _) = state.chat {
                next.chat = .idle(draft: draft, messages: messages)
            }
        }
        return next
    }

    /// 事件应用规则：
    /// - 首个事件建立序号基线；之后连号应用、重复忽略、跳号置 resyncPendingFrom（不丢消息与草稿）；
    /// - 只有 kind=event 且携带消息载荷才应用 Motion 消息：新 messageId 追加，同 messageId
    ///   以最新快照 upsert（phase 1990 流式增量——producer 对同一消息流发累积快照）；
    /// - ack/error/terminal 不追加消息（ack ≠ 回复）；
    /// - 未知 kind 保留 envelope 元数据，以未确认的 system 消息降级展示。
    private static func applyStreamEvent(_ envelope: LauncherEnvelope, to state: inout ChatCoreState) {
        // A reconnect snapshot explicitly starts a fresh per-process sequence baseline.
        // Without this reset, sequence 1 would look older than the previous process tail.
        if envelope.kind == .snapshot,
           envelope.payload["resync"]?.stringValue == "resync_required" {
            state.lastSequence = nil
        }
        let decision: SequenceDecision
        if let last = state.lastSequence {
            decision = classifySequence(previous: last, next: envelope.sequence)
        } else {
            decision = .apply
        }
        switch decision {
        case .duplicate:
            return
        case let .resync(requiredFrom):
            state.resyncPendingFrom = requiredFrom
            return
        case .apply:
            state.lastSequence = envelope.sequence
            state.resyncPendingFrom = nil
        }
        switch envelope.kind {
        case .event:
            applyMessagePayload(envelope.payload, to: &state)
        case .snapshot:
            if case let .array(messages)? = envelope.payload["messages"] {
                for payload in messages { applyMessagePayload(payload, to: &state) }
            }
            if let activity = envelope.payload["activity"] { applyActivityPayload(activity, to: &state) }
        case .daemon:
            // Liveness is a CLI fact. Stopped clears local waiting; running never synthesizes Thinking.
            if envelope.payload["state"]?.stringValue == "stopped" { state.activity = .idle }
        case .activity:
            // 活动行迁移（phase 2001 引入，phase 2002 增 error，phase 2003 Step F 增
            // interrupted/retry/blocked）：processing/responding 单调前进不回退 waiting；
            // 错误族保留可见，只由下一次 sendStarted 或新 activity 覆盖；
            // 未知/畸形 activity payload 只推进 sequence，不产生活动变更。
            applyActivityPayload(envelope.payload, to: &state)
        case .terminal:
            state.activity = .idle // stream 终止兜底清理活动行
        case .unknown(let raw):
            let note = Message(
                id: "unknown-\(envelope.sessionId)-\(envelope.sequence)",
                role: .system,
                text: "未知事件类型 '\(raw)'（seq \(envelope.sequence)），已保留元数据，等待协议升级",
                committed: false
            )
            guard !state.chat.messages.contains(where: { $0.id == note.id }) else { return }
            state.chat = state.chat.appending(note)
        case .ack, .error:
            break
        }
    }

    private static func applyMessagePayload(_ payload: JSONValue, to state: inout ChatCoreState) {
        guard let payload = MotionMessagePayload(payload: payload) else { return }
        let message = Message(id: payload.messageId, role: payload.role, text: payload.text, committed: true)
        if state.chat.messages.contains(where: { $0.id == message.id }) {
            state.chat = state.chat.replacing(message)
        } else {
            state.chat = state.chat.appending(message)
        }
    }

    private static func applyActivityPayload(_ payload: JSONValue, to state: inout ChatCoreState) {
        guard let payload = ActivityPayload(payload: payload) else { return }
        switch payload.phase {
        case .processing: state.activity = .processing(label: payload.label, detail: payload.detail)
        case .responding: state.activity = .responding
        case .idle: state.activity = .idle
        case .error: state.activity = .error(detail: payload.detail)
        case .interrupted: state.activity = .interrupted(detail: payload.detail)
        case .retry: state.activity = .retry(detail: payload.detail)
        case .blocked: state.activity = .blocked(detail: payload.detail)
        }
    }
}
