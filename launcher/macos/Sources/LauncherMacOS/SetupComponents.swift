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
        // 编辑期间 field editor 唯一拥有 stringValue/selection；不逐字符 trim 或回写。
        onTextChange?(stringValue)
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

    final class Coordinator: NSObject {
        var text: Binding<String>
        var focused: Binding<Bool>
        var onSubmit: () -> Void

        init(text: Binding<String>, focused: Binding<Bool>, onSubmit: @escaping () -> Void) {
            self.text = text
            self.focused = focused
            self.onSubmit = onSubmit
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
            guard let coordinator, coordinator.focused.wrappedValue != focused else { return }
            coordinator.focused.wrappedValue = focused
        }
        // 只在控件创建（credentials screen transition）时聚焦一次；updateNSView 不抢焦点。
        DispatchQueue.main.async { [weak field] in
            guard let field, let window = field.window else { return }
            window.makeFirstResponder(field)
        }
        return field
    }

    func updateNSView(_ field: SetupSecureTextField, context: Context) {
        context.coordinator.text = $text
        context.coordinator.focused = isFocused
        context.coordinator.onSubmit = onSubmit
        field.placeholderString = placeholder
        field.isEnabled = isEnabled
        if field.currentEditor() == nil, field.stringValue != text {
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
