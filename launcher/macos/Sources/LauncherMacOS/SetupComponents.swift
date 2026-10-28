import AppKit
import LauncherCore
import SwiftUI

enum SetupField: Hashable {
    case model
    case apiKey
    case baseURL
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

/// API Key 专用原生安全输入。NSText field editor 原生拥有 Command-V、
/// 菜单 Paste 和右键 Paste；不读取或记录剪贴板，也不在粘贴时提交。
final class SetupSecureTextField: NSSecureTextField, NSTextFieldDelegate {
    var onTextChange: ((String) -> Void)?
    var onSubmit: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?

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
        isBezeled = false
        drawsBackground = false
        backgroundColor = .clear
    }

    @objc private func submit() {
        onSubmit?()
    }

    func controlTextDidChange(_ notification: Notification) {
        let normalized = SetupPaste.normalize(stringValue)
        if stringValue != normalized { stringValue = normalized }
        onTextChange?(normalized)
    }

    func controlTextDidBeginEditing(_ notification: Notification) {
        onFocusChange?(true)
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        onFocusChange?(false)
    }
}

struct PasteCapableSecureField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var isFocused: Binding<Bool>
    let onSubmit: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    func makeNSView(context: Context) -> SetupSecureTextField {
        let field = SetupSecureTextField(frame: .zero)
        field.onTextChange = { value in
            if text != value { text = value }
        }
        field.onSubmit = onSubmit
        field.onFocusChange = { focused in
            if isFocused.wrappedValue != focused { isFocused.wrappedValue = focused }
        }
        return field
    }

    func updateNSView(_ field: SetupSecureTextField, context: Context) {
        field.placeholderString = placeholder
        field.isEnabled = isEnabled
        if field.stringValue != text { field.stringValue = text }
        if isFocused.wrappedValue, field.window != nil, field.currentEditor() == nil {
            DispatchQueue.main.async { [weak field] in
                guard let field, isFocused.wrappedValue, let window = field.window else { return }
                window.makeFirstResponder(field)
            }
        } else if !isFocused.wrappedValue, field.currentEditor() != nil {
            field.window?.makeFirstResponder(nil)
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
    let cancel: (() -> Void)?
    @ViewBuilder let content: Content
    @ViewBuilder let actions: Actions

    init(
        step: String? = nil,
        title: String,
        subtitle: String? = nil,
        height: CGFloat,
        cancel: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content,
        @ViewBuilder actions: () -> Actions
    ) {
        self.step = step
        self.title = title
        self.subtitle = subtitle
        self.height = height
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
                    Button(SetupCopy.cancelAction, action: cancel)
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
