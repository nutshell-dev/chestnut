import CoreGraphics
import SwiftUI

public struct MessageStyleSpec: Equatable {
    public let fontSize: CGFloat
    public let weight: Font.Weight
    public let lineSpacing: CGFloat
    public let opacity: Double

    public init(fontSize: CGFloat, weight: Font.Weight, lineSpacing: CGFloat, opacity: Double) {
        self.fontSize = fontSize
        self.weight = weight
        self.lineSpacing = lineSpacing
        self.opacity = opacity
    }
}

/// 对话构图的唯一视觉投影：不包含消息事实，也不读取滚动状态。
public struct DialogueComposition: Equatable {
    public let user: MessageStyleSpec
    public let reply: MessageStyleSpec
    public let firstGroupGap: CGFloat
    public let withinTurnGap: CGFloat
    public let betweenTurnsGap: CGFloat
    public let footerGap: CGFloat

    public static let current = DialogueComposition(
        user: MessageStyleSpec(
            fontSize: LauncherVisual.userBodyFontSize,
            weight: .regular,
            lineSpacing: LauncherVisual.userLineSpacing,
            opacity: LauncherVisual.userOpacity
        ),
        reply: MessageStyleSpec(
            fontSize: LauncherVisual.motionBodyFontSize,
            weight: .regular,
            lineSpacing: LauncherVisual.motionLineSpacing,
            opacity: LauncherVisual.replyOpacity
        ),
        firstGroupGap: 12,
        withinTurnGap: 10,
        betweenTurnsGap: 18,
        footerGap: 10
    )
}

/// 光学比例 token 单一来源（phase 1996）：所有尺寸/字号/留白常量集中此处，
/// view 内禁止散落 magic numbers。行为计算归 ConversationLayout，composer 细节归
/// ComposerStyle，消息排版归 MessageStyle——三者只读本文件的值。
///
/// 历史教训：1991 放大造成空旷/框中框；1993 用左右分栏区分双方被实机否决。
/// 1996 原则：统一左侧单列、composer 无独立表面、尺寸克制，不用放大制造"大气"。
public enum LauncherVisual {
    // MARK: 面板与三态几何
    public static let panelWidth: CGFloat = 640
    public static let compactHeight: CGFloat = 76
    public static let responseMaxWidth: CGFloat = 560
    public static let responseMaxHeight: CGFloat = 420

    // MARK: 输入栏（无独立表面：文字直接在窗口材质上）
    public static let composerHeight: CGFloat = 54
    public static let composerFontSize: CGFloat = 17
    public static let composerHorizontalPadding: CGFloat = 18
    public static let statusSlotWidth: CGFloat = 20
    public static let placeholder: String = "询问 Motion…"

    // MARK: 消息排版（phase 2009：同字号、同字重的同轴对话）
    public static let motionBodyFontSize: CGFloat = 16
    public static let userBodyFontSize: CGFloat = 16
    public static let motionLineSpacing: CGFloat = 3
    public static let userLineSpacing: CGFloat = 3
    public static let userOpacity: Double = 0.82
    public static let replyOpacity: Double = 1
    /// 所有消息直接消费 responseLeadingInset；禁止重新引入 user 专属横向偏移。
    public static var messageLeadingInset: CGFloat { responseLeadingInset }

    // MARK: 外层材质与留白（composer 与回复列共享同一左侧光学起点）
    public static let panelCornerRadius: CGFloat = 12
    /// 面板内容与材质边缘的统一留白（水平与垂直同值）。
    public static let contentInset: CGFloat = 10
    /// 回复列的 leading 内边距：与 composer 文字起点对齐（输入文字起点 = contentInset +
    /// composerHorizontalPadding；回复列在 contentInset 基础上再缩进同一值）。状态行同样消费此轴。
    public static var responseLeadingInset: CGFloat { composerHorizontalPadding }

}
