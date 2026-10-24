import AppKit

/// 窗口层策略决策（可测试的单一来源）。accessory = 不进 Dock/Cmd-Tab；
/// 裸可执行无 bundle，LSUIElement 不生效，programmatic policy 是当前唯一手段。
public enum LauncherWindowPolicy {
    public static let activation: NSApplication.ActivationPolicy = .accessory
}

/// Raycast/Spotlight 风格浮窗：floating level、跨 Space 与全屏辅助层、
/// 透明背景 + 阴影、失焦 orderOut 隐藏。失焦只隐藏，ChatStore draft/stream 状态不动。
public final class LauncherPanel: NSPanel {
    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { true }

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

    @objc private func handleResignKey(_ notification: Notification) {
        orderOut(nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
