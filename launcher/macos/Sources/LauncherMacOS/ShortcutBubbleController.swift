import AppKit

private final class ShortcutBubblePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// 仅用于初始化未完成时的失焦恢复提示；不参与聊天、CLI 或 setup 业务状态。
@MainActor
final class ShortcutBubbleController: NSObject {
    static let text = "⌥ Space 重新打开 Chestnut"
    static let defaultTimeout: TimeInterval = 12
    static let contentSize = NSSize(width: 300, height: 64)
    static let screenInset: CGFloat = 20

    private(set) var window: NSPanel?
    private(set) var generation = 0

    private let timeout: TimeInterval
    private var timeoutTimer: Timer?

    init(timeout: TimeInterval = ShortcutBubbleController.defaultTimeout) {
        self.timeout = timeout
        super.init()
    }

    var isVisible: Bool { window?.isVisible == true }

    func panelDidResign(isSetupIncomplete: Bool, screen: NSScreen) {
        guard isSetupIncomplete else { return }
        show(on: screen)
    }

    func show(on screen: NSScreen) {
        generation += 1
        let currentGeneration = generation
        timeoutTimer?.invalidate()

        let window = window ?? makeWindow()
        self.window = window
        window.setFrame(Self.frame(visibleFrame: screen.visibleFrame), display: true)
        // 只排序显示，不 makeKey、不 activate，也不改变 accessory activation policy。
        window.orderFrontRegardless()

        timeoutTimer = Timer.scheduledTimer(
            timeInterval: timeout,
            target: self,
            selector: #selector(timeoutFired(_:)),
            userInfo: currentGeneration,
            repeats: false
        )
    }

    func hide() {
        generation += 1
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        window?.orderOut(nil)
    }

    @objc private func timeoutFired(_ timer: Timer) {
        guard let timerGeneration = timer.userInfo as? Int else { return }
        handleTimeout(generation: timerGeneration)
    }

    /// generation 让已被替换的旧 timer 无法隐藏后一次 show 的气泡。
    func handleTimeout(generation timerGeneration: Int) {
        guard timerGeneration == generation else { return }
        hide()
    }

    static func frame(
        visibleFrame: NSRect,
        contentSize: NSSize = ShortcutBubbleController.contentSize
    ) -> NSRect {
        NSRect(
            x: visibleFrame.maxX - contentSize.width - screenInset,
            y: visibleFrame.minY + screenInset,
            width: contentSize.width,
            height: contentSize.height
        )
    }

    private func makeWindow() -> NSPanel {
        let panel = ShortcutBubblePanel(
            contentRect: NSRect(origin: .zero, size: Self.contentSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hasShadow = true
        panel.hidesOnDeactivate = false

        let content = NSVisualEffectView(frame: NSRect(origin: .zero, size: Self.contentSize))
        content.material = .hudWindow
        content.blendingMode = .behindWindow
        content.state = .active
        content.wantsLayer = true
        content.layer?.cornerRadius = 12
        content.layer?.masksToBounds = true

        let label = NSTextField(labelWithString: Self.text)
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.textColor = .labelColor
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 16, y: 0, width: Self.contentSize.width - 32, height: Self.contentSize.height)
        label.autoresizingMask = [.width, .height]
        content.addSubview(label)
        panel.contentView = content
        return panel
    }

    deinit {
        timeoutTimer?.invalidate()
    }
}
