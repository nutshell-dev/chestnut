import AppKit
import LauncherCore
import SwiftUI

enum SetupField: Hashable {
    case model
    case apiKey
    case baseURL
    case language
}

struct SetupStepHeader: View {
    let step: String?
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let step {
                Text(step)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            Text(title)
                .font(.system(size: 24, weight: .semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ProviderRow: View {
    let provider: SetupProvider
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(provider.label)
                        .font(.system(size: 15, weight: .medium))
                    Text(provider.description)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: SetupVisual.rowHeight, alignment: .leading)
            .background(
                selected ? Color.accentColor.opacity(0.10) : Color.clear,
                in: RoundedRectangle(cornerRadius: SetupVisual.cornerRadius, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityIdentifier("setup.provider.\(provider.id)")
    }
}

enum SetupPaste {
    /// 只去除剪贴板首尾换行；保留空格、中间字符和供应商自有格式。
    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .newlines)
    }
}

/// API Key 专用原生安全输入。显式 paste 只把剪贴板文本插入当前 field editor，
/// 不记录剪贴板，也不在粘贴时提交。
final class SetupSecureTextField: NSSecureTextField, NSTextFieldDelegate {
    var onTextChange: ((String) -> Void)?
    var onSubmit: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    var onWindowAttach: (() -> Void)?
    var lastContextMenu: NSMenu?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        delegate = self
        target = self
        action = #selector(submit)
        font = .systemFont(ofSize: 14)
        focusRingType = .none
        isEditable = true
        isSelectable = true
        isBezeled = false
        drawsBackground = false
        backgroundColor = .clear
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowAttach?()
    }

    func scheduleFocusRetry(remaining: Int = 40) {
        if let editor = currentEditor(), window?.firstResponder === editor { return }
        if let window {
            isEditable = true
            isSelectable = true
            window.makeFirstResponder(self)
            if currentEditor() == nil { selectText(nil) }
        }
        guard remaining > 0 else { return }
        DispatchQueue.main.async { self.scheduleFocusRetry(remaining: remaining - 1) }
    }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { SetupPasteMenuTarget.noteEditing(self) }
        return accepted
    }

    @objc private func submit() {
        onSubmit?()
    }

    func controlTextDidChange(_ notification: Notification) {
        // 编辑期间 field editor 唯一拥有 stringValue/selection；不逐字符 trim 或回写。
        onTextChange?(stringValue)
    }

    func controlTextDidBeginEditing(_ notification: Notification) {
        SetupPasteMenuTarget.noteEditing(self)
        onFocusChange?(true)
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        SetupPasteMenuTarget.endEditing(self)
        onFocusChange?(false)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSText.paste) else { return false }
        paste(textView)
        return true
    }

    @objc func paste(_ sender: Any?) {
        if sender == nil, currentEditor() == nil {
            window?.makeFirstResponder(self)
            DispatchQueue.main.async { self.paste(nil) }
            return
        }
        guard let editor = (sender as? NSTextView) ?? (currentEditor() as? NSTextView),
              let value = NSPasteboard.general.string(forType: .string) else { return }
        editor.insertText(value, replacementRange: editor.selectedRange)
    }

    func makePasteContextMenu() -> NSMenu {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Paste", action: #selector(paste), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return menu
    }
}

/// accessory app 的 Edit→Paste 入口。只转发给当前正在编辑的 API Key field；
/// 其他输入和聊天 composer 继续走原生 responder chain。
final class SetupPasteMenuTarget: NSObject {
    private static let shared = SetupPasteMenuTarget()
    private static var installed = false
    private(set) static weak var activeField: SetupSecureTextField?

    static func noteEditing(_ field: SetupSecureTextField) {
        activeField = field
    }

    static func endEditing(_ field: SetupSecureTextField) {
        if activeField === field { activeField = nil }
    }

    static func install() {
        guard !installed else { return }
        installed = true
        let mainMenu = NSApp.mainMenu ?? NSMenu()
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        let pasteItem = NSMenuItem(title: "Paste", action: #selector(SetupPasteMenuTarget.paste), keyEquivalent: "v")
        pasteItem.target = shared
        editMenu.addItem(pasteItem)
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    @objc func paste(_ sender: Any?) {
        if let activeField = Self.activeField {
            activeField.paste(nil)
            return
        }
        for window in NSApp.windows {
            guard let field = findSecureField(in: window.contentView), field.currentEditor() != nil else { continue }
            field.paste(nil)
            return
        }
    }

    private func findSecureField(in view: NSView?) -> SetupSecureTextField? {
        guard let view else { return nil }
        if let field = view as? SetupSecureTextField { return field }
        for subview in view.subviews {
            if let field = findSecureField(in: subview) { return field }
        }
        return nil
    }
}

struct PasteCapableSecureField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var isFocused: Binding<Bool>
    let onSubmit: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    final class Coordinator: NSObject {
        var text: Binding<String>
        var focused: Binding<Bool>
        var onSubmit: () -> Void
        var isEditing = false
        private var eventMonitor: Any?

        init(text: Binding<String>, focused: Binding<Bool>, onSubmit: @escaping () -> Void) {
            self.text = text
            self.focused = focused
            self.onSubmit = onSubmit
        }

        func installEventMonitor(_ field: SetupSecureTextField) {
            guard eventMonitor == nil else { return }
            eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .rightMouseDown]) {
                [weak field] event in
                guard let field, field.currentEditor() != nil, event.window === field.window else { return event }
                if event.type == .keyDown,
                   event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                   event.charactersIgnoringModifiers?.lowercased() == "v" {
                    field.paste(nil)
                    return nil
                }
                if event.type == .rightMouseDown {
                    let menu = field.makePasteContextMenu()
                    field.lastContextMenu = menu
                    DispatchQueue.main.async {
                        NSMenu.popUpContextMenu(menu, with: event, for: field)
                    }
                    return nil
                }
                return event
            }
        }

        func removeEventMonitor() {
            if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
            eventMonitor = nil
        }

        func scheduleFocus(_ field: SetupSecureTextField) {
            field.scheduleFocusRetry()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, focused: isFocused, onSubmit: onSubmit)
    }

    func makeNSView(context: Context) -> SetupSecureTextField {
        let field = SetupSecureTextField(frame: .zero)
        field.onTextChange = { [weak coordinator = context.coordinator] value in
            guard let coordinator, coordinator.text.wrappedValue != value else { return }
            coordinator.text.wrappedValue = value
        }
        field.onSubmit = { [weak coordinator = context.coordinator] in
            coordinator?.onSubmit()
        }
        field.onFocusChange = { [weak coordinator = context.coordinator] focused in
            guard let coordinator else { return }
            coordinator.isEditing = focused
            if coordinator.focused.wrappedValue != focused { coordinator.focused.wrappedValue = focused }
        }
        field.onWindowAttach = { [weak coordinator = context.coordinator, weak field] in
            guard let coordinator, let field else { return }
            coordinator.scheduleFocus(field)
        }
        context.coordinator.installEventMonitor(field)
        // window attach 后有界重试；updateNSView 不参与 first responder 管理。
        context.coordinator.scheduleFocus(field)
        return field
    }

    func dismantleNSView(_ field: SetupSecureTextField, context: Context) {
        context.coordinator.removeEventMonitor()
    }

    func updateNSView(_ field: SetupSecureTextField, context: Context) {
        context.coordinator.text = $text
        context.coordinator.focused = isFocused
        context.coordinator.onSubmit = onSubmit
        field.placeholderString = placeholder
        field.isEnabled = isEnabled
        if !context.coordinator.isEditing, field.stringValue != text {
            field.stringValue = text
        }
    }
}

struct SetupFieldRow: View {
    let label: String
    let placeholder: String
    let secure: Bool
    let field: SetupField
    @Binding var text: String
    var focused: FocusState<SetupField?>.Binding
    let onSubmit: () -> Void
    var hint: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            if secure {
                PasteCapableSecureField(
                    text: $text,
                    placeholder: placeholder,
                    isFocused: Binding(
                        get: { focused.wrappedValue == field },
                        set: { focused.wrappedValue = $0 ? field : nil }
                    ),
                    onSubmit: onSubmit
                )
            } else {
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused(focused, equals: field)
                    .onSubmit(onSubmit)
            }
            if let hint {
                Text(hint)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: SetupVisual.rowHeight, alignment: .leading)
        .background(
            Color.primary.opacity(0.045),
            in: RoundedRectangle(cornerRadius: SetupVisual.cornerRadius, style: .continuous)
        )
    }
}

struct SetupPrimaryAction: View {
    let title: String
    let disabled: Bool
    let busy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(title)
            }
            .frame(minWidth: 112, minHeight: 34)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .keyboardShortcut(.defaultAction)
        .disabled(disabled || busy)
    }
}

struct SetupScaffold<Content: View, Actions: View>: View {
    let step: String?
    let title: String
    let subtitle: String?
    let height: CGFloat
    let secondaryTitle: String
    let cancel: (() -> Void)?
    @ViewBuilder let content: Content
    @ViewBuilder let actions: Actions

    init(
        step: String? = nil,
        title: String,
        subtitle: String? = nil,
        height: CGFloat,
        secondaryTitle: String = SetupCopy.cancelAction,
        cancel: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content,
        @ViewBuilder actions: () -> Actions
    ) {
        self.step = step
        self.title = title
        self.subtitle = subtitle
        self.height = height
        self.secondaryTitle = secondaryTitle
        self.cancel = cancel
        self.content = content()
        self.actions = actions()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SetupStepHeader(step: step, title: title, subtitle: subtitle)
            Spacer().frame(height: SetupVisual.sectionGap)
            content
            Spacer(minLength: SetupVisual.sectionGap)
            HStack {
                if let cancel {
                    Button(secondaryTitle, action: cancel)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                actions
            }
            .frame(minHeight: SetupVisual.rowHeight)
        }
        .frame(width: SetupVisual.contentWidth)
        .padding(.vertical, SetupVisual.verticalInset)
        .frame(width: SetupVisual.panelWidth, height: height)
        .background(
            .regularMaterial,
            in: RoundedRectangle(cornerRadius: LauncherVisual.panelCornerRadius, style: .continuous)
        )
    }
}
