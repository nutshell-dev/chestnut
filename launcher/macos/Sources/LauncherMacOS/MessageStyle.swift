import CoreGraphics
import SwiftUI

import LauncherCore

/// 消息排版只消费 DialogueComposition：user 是轻量上下文，Motion 是主要阅读内容；
/// 所有角色同轴 leading。仅 system 保留标签，禁止 inset/trailing/气泡/分隔线。
public enum MessageStyle {
    /// 所有角色统一左对齐（1993 的 user trailing 已被实机否决）。
    public static func frameAlignment(for role: Message.Role) -> Alignment { .leading }

    public static func textAlignment(for role: Message.Role) -> TextAlignment { .leading }

    /// 角色行不增加偏移；共享列轴由 ChatView 统一应用 responseLeadingInset。
    public static func leadingInset(for role: Message.Role) -> CGFloat { 0 }

    public static func font(for role: Message.Role) -> Font {
        let style = spec(for: role)
        return .system(size: style.fontSize, weight: style.weight)
    }

    public static func lineSpacing(for role: Message.Role) -> CGFloat {
        spec(for: role).lineSpacing
    }

    public static func opacity(for role: Message.Role) -> Double {
        spec(for: role).opacity
    }

    public static func spec(for role: Message.Role) -> MessageStyleSpec {
        switch role {
        case .user:
            return DialogueComposition.current.user
        case .motion:
            return DialogueComposition.current.reply
        case .system:
            return MessageStyleSpec(fontSize: 13, weight: .regular, lineSpacing: 2, opacity: 1)
        }
    }

    /// user/system 为次级色、Motion 为主要色（纯角色判定）。
    public static func foregroundIsSecondary(for role: Message.Role) -> Bool {
        role != .motion
    }

    /// 静态颜色契约（phase 2000）：纯角色映射——不读取焦点、选择或点击状态；
    /// 返回语义色（primary/secondary），浅/深色主题由系统解析，不用固定黑白。
    public static func foreground(for role: Message.Role) -> Color {
        foregroundIsSecondary(for: role) ? .secondary : .primary
    }

    /// 正常对话不显示角色名称；仅 system 消息保留标签（错误/状态需要解释来源）。
    public static func showsRoleLabel(for message: Message) -> Bool {
        message.role == .system
    }
}
