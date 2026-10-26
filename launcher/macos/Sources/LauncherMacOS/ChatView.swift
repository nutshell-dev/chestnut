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
    /// 输入焦点显式管理：发送中 disabled 会丟 firstResponder，提交完成后必须恢复，
    /// 保证用户可以连续输入（Spotlight/Raycast 语义）。
    @FocusState private var inputFocused: Bool

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
        // 单一内容轴（phase 1998）：composer/response/status 全部 leading，
        // section 间距由各自 padding token 承担（VStack spacing 归零，节奏可解释）。
        VStack(alignment: .leading, spacing: 0) {
            composer
            if mode != .compact {
                responseArea
                    .padding(.top, LauncherVisual.composerToResponseGap)
            }
            // Motion 活动行（phase 2002 claw bar 布局）：固定在回复列表之后、status 之前，
            // 不插入消息之间——活动出现/消失只改变窗口底部高度，不重排已有消息。
            // 发送后立即出现，turn 事件刷新同一行，turn 终止才撤；error 保留到下一次发送。
            if let activityText = ActivityStyle.text(for: store.activity) {
                activityBar(text: activityText, activity: store.activity)
                    .padding(.top, ActivityStyle.topGap)
            }
            if case let .degraded(_, _, error) = store.state {
                statusLine(error)
                    .padding(.top, LauncherVisual.responseToStatusGap)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(LauncherVisual.contentInset)
        // 浮层视觉外壳：材质与圆角只作用于背景层，消息文本保持不透明；
        // 单一外层材质表达浮层边界（不引入第二个表面）。
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: LauncherVisual.panelCornerRadius, style: .continuous))
        .frame(width: ConversationLayout.width - 2 * LauncherVisual.contentInset)
        .onAppear {
            store.startStream()
            inputFocused = true
        }
        .onChange(of: isSending) { sending in
            if !sending { inputFocused = true }
        }
        .onChange(of: input) { newValue in store.updateDraft(newValue) }
        .onChange(of: store.state.draft) { newValue in
            if newValue != input { input = newValue }
        }
        .onPreferenceChange(ResponseHeightPreferenceKey.self) { height in
            responseContentHeight = height
            reportWindowHeight()
        }
        .onChange(of: messages.count) { _ in reportWindowHeight() }
        .onChange(of: store.activity) { _ in reportWindowHeight() }
    }

    /// 活动行高度贡献：可见时 = 行高 + 顶部间距；
    /// compact/expanded 窗口相应增长，capped 窗口不超高（回复区让位，见 responseArea）。
    private var activityContribution: CGFloat {
        ActivityStyle.text(for: store.activity) != nil
            ? ActivityStyle.lineHeight + ActivityStyle.topGap
            : 0
    }

    /// 当前内容所需窗口高度，变化超过最小增量才上报。
    private func reportWindowHeight() {
        let base = ConversationLayout.windowHeight(for: mode, responseHeight: responseContentHeight)
        let target = mode == .capped ? base : base + activityContribution
        onWindowHeightChange?(target)
    }

    /// composer 永远固定在顶部；Spotlight/Raycast 风格无边框主输入（视觉常量归 ComposerStyle）。
    /// Return 提交，无独立发送按钮；busy 只在右侧预留槽显示，不改变输入栏高度。
    private var composer: some View {
        HStack(spacing: 8) {
            TextField(ComposerStyle.placeholder, text: $input)
                .textFieldStyle(.plain)
                .font(ComposerStyle.font)
                .focused($inputFocused)
                .disabled(isSending)
                .onSubmit { Task { await store.submit() } }
            // 固定右侧状态槽：忙碌时出现小进度，空闲时占位，宽度恒定不抖动
            ZStack {
                if isSending {
                    ProgressView()
                        .scaleEffect(0.6)
                }
            }
            .frame(width: ComposerStyle.statusSlotWidth)
        }
        .padding(.horizontal, ComposerStyle.horizontalPadding)
        .frame(height: ComposerStyle.height)
        //  Spotlight 语义：输入区无独立背景/边框，文字直接在窗口材质上（实机决策：
        // 独立材质+边框在窗口材质上形成“框中框”印记）
        .accessibilityIdentifier("composer")
    }

    /// Motion 活动行：单行、与对话列共享同一内容轴（x=28）、14pt 次级色（× opacity）；
    /// spinner 表活动进行中；error 态无 spinner、橙色全不透明。文本/视觉数值全部由
    /// ActivityStyle 单源决定（本函数只消费 token，不写散落数值）。
    private func activityBar(text: String, activity: ActivityState) -> some View {
        HStack(spacing: 6) {
            if ActivityStyle.showsSpinner(activity) {
                ProgressView()
                    .scaleEffect(ActivityStyle.spinnerScale)
                    .frame(width: 10, height: 10)
            } else {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: ActivityStyle.errorIconSize))
                    .foregroundColor(.orange)
            }
            Text(text)
                .font(.system(size: ActivityStyle.fontSize, weight: .regular))
                .foregroundStyle(ActivityStyle.isError(activity) ? Color.orange : Color.secondary.opacity(ActivityStyle.opacity))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.leading, LauncherVisual.responseLeadingInset)
        .frame(height: ActivityStyle.lineHeight)
        .accessibilityIdentifier("activityBar")
    }

    /// 回复区：单一阅读列限宽 560pt 且左对齐——与 composer 共享同一左侧光学起点（phase 1996）。
    /// stream 增量由 SwiftUI diff 只更新最后一条 Motion 消息。高度 = min(内容, 上限)，超限
    /// 内部滚动并自动跟随到底部（新消息与流式快照更新都触发）。
    /// phase 2003 实机修复：内容栈用 VStack 而非 LazyVStack——LazyVStack 按可见区懒物化行，
    /// 与 background 测量构成闭环（ScrollView 高度钳位 → 只物化可见行 → 测回≈帧高 → 永不增长，
    /// 实机症状：两行内容只显示一行半、不随行数扩大）；VStack 报告全部子视图自然高度，
    /// 测量单向化。launcher 消息量小（几十条量级），懒加载无收益。
    private var responseArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // 块间节奏单源：spacing 归零，由 MessageStyle.blockPadding 承担（phase 1998）
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(messages) { message in
                        messageRow(message)
                            .id(message.id)
                    }
                }
                .frame(maxWidth: LauncherVisual.responseMaxWidth, alignment: .leading)
                // 与 composer 文字共享左侧光学起点（回复列缩进 = composer 水平内边距）
                .padding(.leading, LauncherVisual.responseLeadingInset)
                // 让阅读列贴左（ScrollView 内容窄于容器时默认居中，会破坏共享左起点）
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(key: ResponseHeightPreferenceKey.self, value: geo.size.height)
                    }
                )
            }
            .frame(height: max(
                // capped 时窗口不超高：活动行可见期间回复区让出同等高度
                ConversationLayout.responseAreaHeight(for: mode, responseHeight: responseContentHeight)
                    - (mode == .capped ? activityContribution : 0),
                0
            ))
            .accessibilityIdentifier("responseScrollView")
            .onChange(of: messages.count) { _ in scrollToBottom(proxy) }
            .onChange(of: messages.last?.text) { _ in scrollToBottom(proxy) }
        }
    }

    /// 内容超过回复区后自动跟随最新位置；不改变窗口高度与输入框位置。
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        guard let last = messages.last else { return }
        proxy.scrollTo(last.id, anchor: .bottom)
    }

    /// 无角色名单列对话（phase 1996）：所有消息从同一左侧阅读列开始；user 仅靠轻微
    /// leading inset、次级颜色和较小字号区分，Motion 保持主要文本；仅 system 保留标签。
    /// 消息行是纯呈现（phase 2000）：无 textSelection、无点击手势、无选择/焦点状态——
    /// phase1999 实机证明 textSelection（无论在 row 还是容器）会引起黑灰串扰，故整体移除；
    /// 颜色仅由 MessageStyle.foreground(for:) 角色映射决定。复制能力边界见 Step C 决策。
    private func messageRow(_ message: Message) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if MessageStyle.showsRoleLabel(for: message) {
                Text("系统")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(message.text)
                .font(MessageStyle.font(for: message.role))
                .lineSpacing(MessageStyle.lineSpacing(for: message.role))
                .foregroundStyle(MessageStyle.foreground(for: message.role))
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, MessageStyle.leadingInset(for: message.role))
        }
        .padding(.vertical, MessageStyle.blockPadding(for: message.role))
    }

    /// 低干扰状态行：错误一行呈现，保留重试/关闭，不把窗口撑到固定大高度；
    /// 与对话列共享同一 content axis（x=28），间距 token 由外层 VStack 处加（responseToStatusGap）。
    /// phase 2003 Step E：错误文本原样显示 ChatError.detail（daemon/turn 错误已由 CLI 侧
    /// claw bar 共享 formatter 格式化），本地不再按类别拼接前缀。
    private func statusLine(_ error: ChatError) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.caption)
            Text(error.detail)
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
        .padding(.leading, LauncherVisual.responseLeadingInset)
        .accessibilityIdentifier("statusLine")
    }

    private var isSending: Bool {
        if case .sending = store.state { return true }
        return false
    }
}
