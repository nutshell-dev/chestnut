import Combine
import Foundation
import LauncherCore

/// 唯一 UI 状态 owner（@MainActor）：将 core reducer 映射为 SwiftUI published state。
/// view 只绑定 published state；进程、IO、退出码解释都在 adapter 层之外。
@MainActor
public final class ChatStore: ObservableObject {
    @Published public private(set) var snapshot: ChatCoreState

    private let send: any SendClient
    private let stream: any StreamClient
    private let makeRequestId: () -> RequestId
    private let reconnectBackoff: (Int) -> TimeInterval
    private var streamTask: Task<Void, Never>?
    private var stopping = false

    public init(
        send: any SendClient,
        stream: any StreamClient,
        makeRequestId: @escaping () -> RequestId = { UUID().uuidString },
        reconnectBackoff: @escaping (Int) -> TimeInterval = { attempt in
            min(2, 0.1 * pow(2.0, Double(attempt)))
        }
    ) {
        self.snapshot = ChatCoreState()
        self.send = send
        self.stream = stream
        self.makeRequestId = makeRequestId
        self.reconnectBackoff = reconnectBackoff
    }

    public var state: ChatState { snapshot.chat }

    /// Motion 活动行状态（phase 2001）：ChatView 活动行唯一绑定源。
    public var activity: ActivityState { snapshot.activity }

    public func updateDraft(_ text: String) {
        dispatch(.draftChanged(text))
    }

    /// ack 前关闭窗口不丢输入：草稿只在 sendAccepted 后清除。
    public func submit() async {
        if case .degraded = snapshot.chat {
            dispatch(.errorDismissed)
        }
        guard case let .idle(draft, _) = snapshot.chat, !draft.isEmpty else { return }
        let requestId = makeRequestId()
        dispatch(.sendStarted(requestId: requestId))
        do {
            let ack = try await send.submit(requestId: requestId, text: draft)
            if ack.accepted {
                dispatch(.sendAccepted(requestId: requestId))
            } else {
                dispatch(.sendFailed(.rejected(detail: ack.detail ?? "send not accepted")))
            }
        } catch let error as ChatError {
            dispatch(.sendFailed(error))
        } catch {
            dispatch(.sendFailed(.transport(detail: error.localizedDescription)))
        }
    }

    public func startStream() {
        guard streamTask == nil else { return }
        stopping = false
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.consumeStream(fromSequence: self.snapshot.lastSequence)
            self.streamTask = nil
        }
    }

    /// 用户主动退出：只停止子进程，不伪造业务失败、不自动重发。
    public func stopStream() async {
        stopping = true
        let task = streamTask
        task?.cancel()
        await stream.stop()
        await task?.value
        streamTask = nil
        dispatch(.streamStoppedByUser)
    }

    public func dismissError() {
        dispatch(.errorDismissed)
    }

    private func dispatch(_ action: ChatAction) {
        snapshot = ChatReducer.reduce(snapshot, action)
    }

    private func consumeStream(fromSequence: Int?) async {
        var fromSequence = fromSequence
        var retryAttempt = 0

        subscription: while !Task.isCancelled && !stopping {
            let events = stream.events(fromSequence: fromSequence)
            do {
                for try await envelope in events {
                    if Task.isCancelled || stopping { return }
                    dispatch(.streamEvent(envelope))
                    retryAttempt = 0
                    if let requiredFrom = snapshot.resyncPendingFrom {
                        // 跳号：停止当前订阅、从缺口恢复；已确认消息与未确认草稿不动。
                        await stream.stop()
                        if Task.isCancelled || stopping { return }
                        fromSequence = requiredFrom
                        continue subscription
                    }
                    if envelope.kind == .terminal { return }
                }
                return
            } catch let error as ChatError {
                if Task.isCancelled || stopping { return }
                guard case .transport = error else {
                    dispatch(.streamFailed(error))
                    return
                }
            } catch {
                if Task.isCancelled || stopping { return }
                // 未知 adapter 错误沿用 transport 分类，只有这一类会尝试恢复。
            }

            let delay = reconnectBackoff(retryAttempt)
            retryAttempt += 1
            if delay > 0 {
                do {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                } catch {
                    return
                }
            }
            if Task.isCancelled || stopping { return }
            fromSequence = snapshot.resyncPendingFrom ?? snapshot.lastSequence
        }
    }
}
