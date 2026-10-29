import LauncherCore
import SwiftUI

/// 回复区内容高度单向上报（preference key）：窗口 resize 不反写消息状态，避免测量反馈循环。
struct ResponseHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// 纯 UI 视觉组：user 开组，后续非 user 归入该轮；孤立回复独立成组。
/// id 取自首条消息，流式 upsert 不改变组身份，不引入新的 ChatState。
enum MessageBoundary: Equatable {
    case userStart
    case motionContinuation
    case motionNewMessage
}

struct DialogueItem: Identifiable {
    let id: String
    let message: Message
    let boundary: MessageBoundary

    init(message: Message, boundary: MessageBoundary) {
        self.id = message.id
        self.message = message
        self.boundary = boundary
    }
}

struct DialogueGroup: Identifiable {
    let id: String
    var messages: [Message]

    var items: [DialogueItem] {
        messages.enumerated().map { index, message in
            let isNewMotionBlock = index > 0
                && message.role == .motion
                && messages[index - 1].role == .motion
            return DialogueItem(
                message: message,
                boundary: message.role == .user
                    ? .userStart
                    : isNewMotionBlock ? .motionNewMessage : .motionContinuation
            )
        }
    }
}

func makeDialogueGroups(_ messages: [Message]) -> [DialogueGroup] {
    messages.reduce(into: []) { groups, message in
        if message.role == .user || groups.isEmpty {
            groups.append(DialogueGroup(id: message.id, messages: [message]))
        } else {
            groups[groups.count - 1].messages.append(message)
        }
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
    private let semantics: LauncherUiSemantics?

    public init(store: ChatStore, semantics: LauncherUiSemantics? = nil,
                onWindowHeightChange: ((CGFloat) -> Void)? = nil) {
        self.store = store
        self.semantics = semantics
        self.onWindowHeightChange = onWindowHeightChange
    }

    private var copy: SetupPresentationCopy { SetupPresentationCopy(semantics: semantics) }

    private var messages: [Message] { store.state.messages }
    private var dialogueGroups: [DialogueGroup] { makeDialogueGroups(messages) }
    private var composition: DialogueComposition { .current }

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
                    .padding(.top, composition.firstGroupGap)
            }
            // Motion 活动行（phase 2002 claw bar 布局）：固定在回复列表之后、status 之前，
            // 不插入消息之间——活动出现/消失只改变窗口底部高度，不重排已有消息。
            // 发送后立即出现，turn 事件刷新同一行，turn 终止才撤；error 保留到下一次发送。
            if let activityText = ActivityStyle.text(for: store.activity, semantics: semantics) {
                activityBar(text: activityText, activity: store.activity)
                    .padding(.top, composition.footerGap)
            }
            if case let .degraded(_, _, error) = store.state {
                statusLine(error)
                    .padding(.top, composition.footerGap)
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
        ActivityStyle.text(for: store.activity, semantics: semantics) != nil
            ? ActivityStyle.lineHeight + composition.footerGap
            : 0
    }

    /// 当前内容所需窗口高度，变化超过最小增量才上报。
    private func reportWindowHeight() {
        let base = ConversationLayout.windowHeight(for: mode, responseHeight: responseContentHeight)
        let target = min(base + activityContribution, ConversationLayout.expandedHeight)
        onWindowHeightChange?(target)
    }

    /// composer 永远固定在顶部；Spotlight/Raycast 风格无边框主输入（视觉常量归 ComposerStyle）。
    /// Return 提交，无独立发送按钮；busy 只在右侧预留槽显示，不改变输入栏高度。
    private var composer: some View {
        let field = copy.field("chat.composer")
        return HStack(spacing: 8) {
            TextField(field.placeholder ?? field.label, text: $input)
                .textFieldStyle(.plain)
                .font(ComposerStyle.font)
                .focused($inputFocused)
                .disabled(isSending)
                .onSubmit { Task { await store.submit() } }
                .nativeAccessibility(NativeAccessibilityProjection(
                    identifier: field.id,
                    label: field.label,
                    hint: field.hint,
                    role: .textField,
                    enabled: !isSending,
                    focused: inputFocused
                ))
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
        .nativeAccessibility(NativeAccessibilityProjection(
            identifier: activityIdentifier(for: activity),
            label: text,
            hint: copy.state(activityIdentifier(for: activity)).hint,
            role: .staticText
        ))
    }

    /// 回复区：单一阅读列限宽 560pt 且左对齐——与 composer 共享同一左侧光学起点（phase 1996）。
    /// stream 增量由 SwiftUI diff 只更新最后一条 Motion 消息。高度 = min(内容, 上限)，超限
    /// 内部滚动并自动跟随到底部（新消息与流式快照更新都触发）。
    /// phase 2003 实机修复：内容栈用 VStack 而非 LazyVStack——LazyVStack 按可见区懒物化行，
    /// 与 background 测量构成闭环（ScrollView 高度钳位 → 只物化可见行 → 测回≈帧高 → 永不增长，
    /// 实机症状：两行内容只显示一行半、不随行数扩大）；VStack 报告全部子视图自然高度，
    /// 测量单向化。launcher 消息量小（几十条量级），懒加载无收益。
    private var responseArea: some View {
        // 贴底由 ScrollFollowAnchor 承担（AppKit post-layout 直滚 documentView）；
        // ScrollViewProxy.scrollTo 在流式更新事务中会被丢弃（phase 2007 Step A 事实：
        // main 实机探针贴底 2/89）。本分支只含贴底修复，视觉构图保持 main 现状。
        ScrollView {
            // 首组、组内、组间、footer 节奏均归 composition；user/reply 始终共享同一 x。
            VStack(alignment: .leading, spacing: composition.betweenTurnsGap) {
                ForEach(dialogueGroups) { group in
                    VStack(alignment: .leading, spacing: composition.withinTurnGap) {
                        ForEach(group.items) { item in
                            if item.boundary == .motionNewMessage {
                                Rectangle()
                                    .fill(Color.primary.opacity(composition.motionBoundaryOpacity))
                                    .frame(height: 1)
                                    .padding(.vertical, composition.motionMessageGap)
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(true)
                            }
                            messageRow(item.message)
                                .id(item.id)
                        }
                    }
                }
            }
            .frame(maxWidth: LauncherVisual.responseMaxWidth, alignment: .leading)
            // 与 composer 文字共享左侧光学起点（回复列缩进 = composer 水平内边距）
            .padding(.leading, LauncherVisual.responseLeadingInset)
            // 让阅读列贴左（ScrollView 内容窄于容器时默认居中，会破坏共享左起点）
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ScrollFollowAnchor(contentRevision: contentRevision))
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: ResponseHeightPreferenceKey.self, value: geo.size.height)
                }
            )
        }
        .frame(height: max(
            // capped 时窗口不超高：活动行可见期间回复区让出同等高度
            ConversationLayout.responseAreaHeight(
                for: mode,
                responseHeight: responseContentHeight,
                footerHeight: activityContribution
            ),
            0
        ))
        .nativeAccessibility(NativeAccessibilityProjection(
            identifier: "chat.response",
            label: copy.screen("chat").title,
            role: .scrollArea
        ))
    }

    /// 贴底内容版本号：只由消息数与末条文本长度派生——新消息、流式快照都覆盖；
    /// composer 打字等无关状态变化不产生新 revision。
    private var contentRevision: Int {
        messages.count * 100_000 + (messages.last?.text.count ?? 0)
    }

    /// 无角色名同轴对话（phase 2009）：user/reply 同字号同字重，
    /// 仅以语义色、有限 opacity 和垂直节奏区分；不增加任何角色横向偏移。
    /// 消息行是纯呈现（phase 2000）：无 textSelection、无点击手势、无选择/焦点状态——
    /// phase1999 实机证明 textSelection（无论在 row 还是容器）会引起黑灰串扰，故整体移除；
    /// 颜色仅由 MessageStyle.foreground(for:) 角色映射决定。复制能力边界见 Step C 决策。
    private func messageRow(_ message: Message) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if MessageStyle.showsRoleLabel(for: message) {
                Text(copy.state("chat.system").label)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(message.text)
                .font(MessageStyle.font(for: message.role))
                .lineSpacing(MessageStyle.lineSpacing(for: message.role))
                .foregroundStyle(MessageStyle.foreground(for: message.role).opacity(MessageStyle.opacity(for: message.role)))
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, MessageStyle.leadingInset(for: message.role))
        }
        .nativeAccessibility(NativeAccessibilityProjection(
            identifier: "chat.response.\(message.id)",
            label: message.text,
            role: .staticText
        ))
    }

    /// 低干扰状态行：错误一行呈现，保留重试/关闭，不把窗口撑到固定大高度；
    /// 与对话列共享同一 content axis（x=28），间距由 composition.footerGap 承担。
    /// phase 2003 Step E：错误文本原样显示 ChatError.detail（daemon/turn 错误已由 CLI 侧
    /// claw bar 共享 formatter 格式化），本地不再按类别拼接前缀。
    private func statusLine(_ error: ChatError) -> some View {
        let retry = copy.action("chat.retry")
        let close = copy.action("chat.close")
        return HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.caption)
            Text(error.detail)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
            Button(retry.label) { Task { await store.submit() } }
                .font(.caption)
                .nativeAccessibility(NativeAccessibilityProjection(
                    identifier: retry.id, label: retry.label, hint: retry.hint, role: .button
                ))
            Button(close.label) { store.dismissError() }
                .font(.caption)
                .nativeAccessibility(NativeAccessibilityProjection(
                    identifier: close.id, label: close.label, hint: close.hint, role: .button
                ))
        }
        .padding(.leading, LauncherVisual.responseLeadingInset)
        .nativeAccessibility(NativeAccessibilityProjection(
            identifier: "chat.error",
            label: error.detail,
            role: .group
        ))
    }

    private func activityIdentifier(for activity: ActivityState) -> String {
        switch activity {
        case .idle, .waiting: return "activity.waiting"
        case .responding: return "activity.responding"
        case let .processing(label, _):
            return label == "tool" || label == "tool_result" ? "activity.tool" : "activity.thinking"
        case .error: return "activity.error"
        case .interrupted: return "activity.interrupted"
        case .retry: return "activity.retry"
        case .blocked: return "activity.blocked"
        }
    }

    private var isSending: Bool {
        if case .sending = store.state { return true }
        return false
    }
}
