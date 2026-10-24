import LauncherCore
import SwiftUI

/// 回复区内容高度单向上报（preference key）：窗口 resize 不反写消息状态，避免测量反馈循环。
struct ResponseHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// SwiftUI 视图：只绑定 ChatStore 的 published state；不创建 Process、不读文件、不解释退出码。
/// 三态布局：compact（仅顶部 composer）→ expanded（composer 顶部固定 + 回复区增量增长）
/// → capped（回复区达上限后内部滚动，窗口高度固定）。
public struct ChatView: View {
    @ObservedObject private var store: ChatStore
    @State private var input: String = ""
    @State private var responseContentHeight: CGFloat = 0

    /// 内容高度变化时上报目标窗口高度（由 LauncherApp 接线到 panel.resize）；
    /// 单向上报，不反写消息状态。
    private let onWindowHeightChange: ((CGFloat) -> Void)?

    public init(store: ChatStore, onWindowHeightChange: ((CGFloat) -> Void)? = nil) {
        self.store = store
        self.onWindowHeightChange = onWindowHeightChange
    }

    private var messages: [Message] { store.state.messages }

    private var mode: LayoutMode {
        ConversationLayout.layoutMode(messageCount: messages.count, responseHeight: responseContentHeight)
    }

    public var body: some View {
        VStack(spacing: 0) {
            composer
            if mode != .compact {
                responseArea
            }
            if case let .degraded(_, _, error) = store.state {
                statusLine(error)
            }
        }
        .padding(10)
        // 浮层视觉外壳：材质与圆角只作用于背景层，消息文本保持不透明
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .frame(width: ConversationLayout.width - 20)
        .onAppear { store.startStream() }
        .onChange(of: input) { newValue in store.updateDraft(newValue) }
        .onChange(of: store.state.draft) { newValue in
            if newValue != input { input = newValue }
        }
        .onPreferenceChange(ResponseHeightPreferenceKey.self) { height in
            responseContentHeight = height
            reportWindowHeight()
        }
        .onChange(of: messages.count) { _ in reportWindowHeight() }
    }

    /// 当前内容所需窗口高度，变化超过最小增量才上报。
    private func reportWindowHeight() {
        let target = ConversationLayout.windowHeight(for: mode, responseHeight: responseContentHeight)
        onWindowHeightChange?(target)
    }

    /// composer 永远固定在顶部；Return 提交，无独立发送按钮占据初始布局。
    private var composer: some View {
        HStack(spacing: 8) {
            TextField("消息…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .disabled(isSending)
                .onSubmit { Task { await store.submit() } }
            if isSending {
                ProgressView()
                    .scaleEffect(0.7)
            }
        }
        .padding(.vertical, 8)
        .accessibilityIdentifier("composer")
    }

    /// 回复区：用户消息次级样式、Motion 回复主要文本；stream 增量由 SwiftUI diff
    /// 只更新最后一条 Motion 消息。高度 = min(内容, 上限)，超限内部滚动。
    private var responseArea: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(messages) { message in
                    messageRow(message)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: ResponseHeightPreferenceKey.self, value: geo.size.height)
                }
            )
        }
        .frame(height: ConversationLayout.responseAreaHeight(for: mode, responseHeight: responseContentHeight))
        .accessibilityIdentifier("responseScrollView")
    }

    private func messageRow(_ message: Message) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(roleLabel(message))
                .font(.caption)
                .foregroundColor(.secondary)
            Text(message.text)
                .textSelection(.enabled)
                .font(message.role == .user ? .callout : .body)
                .foregroundColor(message.role == .user ? .secondary : .primary)
        }
        .padding(.vertical, 2)
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

    /// 低干扰状态行：错误一行呈现，保留重试/关闭，不把窗口撑到固定大高度。
    private func statusLine(_ error: ChatError) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.caption)
            Text(errorText(error))
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
            Button("重试") { Task { await store.submit() } }
                .font(.caption)
            Button("关闭") { store.dismissError() }
                .font(.caption)
        }
        .padding(.top, 4)
        .accessibilityIdentifier("statusLine")
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
