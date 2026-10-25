import CoreGraphics
import SwiftUI

import LauncherCore

/// 消息排版单一来源（phase 1996）：统一左侧单列——所有角色 frame/text alignment 均为 leading；
/// 正常对话不显示角色名，user 仅靠轻微 leading inset、次级颜色、较小字号区分；
/// 仅 system 消息保留标签解释来源。禁止 trailing/气泡/分隔线。
public enum MessageStyle {
    /// 所有角色统一左对齐（1993 的 user trailing 已被实机否决）。
    public static func frameAlignment(for role: Message.Role) -> Alignment { .leading }

    public static func textAlignment(for role: Message.Role) -> TextAlignment { .leading }

    /// user 的轻微左缩进；Motion/system 为 0。
    public static func leadingInset(for role: Message.Role) -> CGFloat {
        role == .user ? LauncherVisual.userLeadingInset : 0
    }

    public static func font(for role: Message.Role) -> Font {
        switch role {
        case .motion: return .system(size: LauncherVisual.motionBodyFontSize, weight: .regular)
        case .user: return .system(size: LauncherVisual.userBodyFontSize, weight: .regular)
        case .system: return .caption
        }
    }

    public static func lineSpacing(for role: Message.Role) -> CGFloat {
        role == .motion ? LauncherVisual.motionLineSpacing : LauncherVisual.userLineSpacing
    }

    /// 消息块垂直节奏（块间距单源，phase 1998；LazyVStack spacing 已归零）。
    /// lineSpacing 是块内行间节奏，blockPadding 是块间节奏——职责分离。
    public static func blockPadding(for role: Message.Role) -> CGFloat {
        role == .motion ? LauncherVisual.motionBlockPadding : LauncherVisual.userBlockPadding
    }

    public static func foregroundIsSecondary(for role: Message.Role) -> Bool {
        role != .motion
    }

    /// 正常对话不显示角色名称；仅 system 消息保留标签（错误/状态需要解释来源）。
    public static func showsRoleLabel(for message: Message) -> Bool {
        message.role == .system
    }
}
