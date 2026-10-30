import AppKit

/// 窗口层策略决策（可测试的单一来源）。accessory = 不进 Dock/Cmd-Tab；
/// 裸可执行无 bundle，LSUIElement 不生效，programmatic policy 是当前唯一手段。
public enum LauncherWindowPolicy {
    public static let activation: NSApplication.ActivationPolicy = .accessory
}

protocol LauncherPanelDelegate: AnyObject {
    @MainActor func launcherPanelDidResign(_ panel: LauncherPanel, screen: NSScreen?)
}

/// Raycast/Spotlight 风格浮窗：floating level、跨 Space 与全屏辅助层、
/// 透明背景 + 阴影、失焦 orderOut 隐藏。失焦只隐藏，ChatStore draft/stream 状态不动。
public final class LauncherPanel: NSPanel {
    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { true }

    private var isHidingExplicitly = false
    private var isHidingAfterResign = false

    public init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        hasShadow = true
        isMovableByWindowBackground = true
        // 浮窗不显示红绿灯按钮；关闭语义由 delegate windowShouldClose 保留（隐藏不退出）
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleResignKey),
            name: NSWindow.didResignKeyNotification,
            object: self
        )
    }

    /// 内容驱动 resize：顶部锚定向下增长（水平中心不变），保持 key window；
    /// 小于最小增量的变化忽略（抑制流式增量抖动）。不改 accessory/失焦语义。
    public func resize(toHeight height: CGFloat, animated: Bool = true) {
        guard ConversationLayout.shouldResize(from: frame.height, to: height) else { return }
        var newFrame = frame
        let delta = height - newFrame.height
        newFrame.size.height = height
        newFrame.origin.y -= delta // 顶部锚定：向下增长
        setFrame(newFrame, display: true, animate: animated)
    }

    public override func cancelOperation(_ sender: Any?) {
        hideWithoutShortcutHint()
    }

    /// Esc、显式关闭和热键隐藏只隐藏 launcher，不触发初始化失焦提示。
    func hideWithoutShortcutHint() {
        isHidingExplicitly = true
        defer { isHidingExplicitly = false }
        orderOut(nil)
    }

    public override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard LauncherPanel.isUnmodifiedEscape(event) else {
            return super.performKeyEquivalent(with: event)
        }
        hideWithoutShortcutHint()
        return true
    }

    static func isUnmodifiedEscape(_ event: NSEvent) -> Bool {
        event.keyCode == 53 && event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty
    }

    @objc @MainActor private func handleResignKey(_ notification: Notification) {
        guard !isHidingExplicitly, !isHidingAfterResign else { return }
        let previousScreen = screen
        isHidingAfterResign = true
        orderOut(nil)
        isHidingAfterResign = false
        (delegate as? LauncherPanelDelegate)?.launcherPanelDidResign(self, screen: previousScreen)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
