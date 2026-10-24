import LauncherCore
import SwiftUI

/// SwiftUI 视图：只绑定 ChatStore 的 published state；不创建 Process、不读文件、不解释退出码。
public struct ChatView: View {
    @ObservedObject private var store: ChatStore
    @State private var input: String = ""

    public init(store: ChatStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            messageList
            Divider()
            if case let .degraded(_, _, error) = store.state {
                errorBanner(error)
                Divider()
            }
            composer
        }
        .padding(10)
        // 浮层视觉外壳：材质与圆角只作用于背景层，消息文本保持不透明
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .frame(minWidth: 620, minHeight: 440)
        .onAppear { store.startStream() }
        .onChange(of: input) { newValue in store.updateDraft(newValue) }
        .onChange(of: store.state.draft) { newValue in
            if newValue != input { input = newValue }
        }
    }

    private var messageList: some View {
        Group {
            if store.state.messages.isEmpty {
                VStack {
                    Spacer()
                    Text("向 Motion 发送消息开始会话")
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                List(store.state.messages) { message in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(roleLabel(message))
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(message.text)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 2)
                }
                .scrollContentBackground(.hidden) // 让窗口材质透过列表背景
            }
        }
    }

    private func roleLabel(_ message: Message) -> String {
        let base: String
        switch message.role {
        case .user: base = "你"
        case .motion: base = "Motion"
        case .system: base = "系统"
        }
        return message.committed ? base : "\(base)（未确认）"
    }

    private func errorBanner(_ error: ChatError) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle")
            Text(errorText(error))
                .font(.callout)
                .lineLimit(3)
            Spacer()
            Button("重试") { Task { await store.submit() } }
            Button("关闭") { store.dismissError() }
        }
        .padding(8)
        .background(Color.yellow.opacity(0.15))
    }

    private var composer: some View {
        HStack {
            TextField("消息…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .disabled(isSending)
            if isSending {
                ProgressView()
                    .scaleEffect(0.7)
            } else {
                Button("发送") { Task { await store.submit() } }
                    .disabled(store.state.draft.isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(8)
    }

    private var isSending: Bool {
        if case .sending = store.state { return true }
        return false
    }

    private func errorText(_ error: ChatError) -> String {
        switch error {
        case let .transport(detail): return "连接失败：\(detail)"
        case let .rejected(detail): return "Chestnut 拒绝：\(detail)"
        case let .protocolMismatch(detail): return "协议不兼容：\(detail)"
        case let .daemon(detail): return "Motion daemon 不可用：\(detail)"
        case let .local(detail): return "Launcher 本地错误：\(detail)"
        }
    }
}
