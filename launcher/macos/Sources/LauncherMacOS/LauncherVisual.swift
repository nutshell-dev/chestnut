import CoreGraphics
import SwiftUI

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

    // MARK: 消息排版（统一左侧单列；user 仅靠 inset/颜色/字号一级差异区分）
    public static let motionBodyFontSize: CGFloat = 16
    public static let userBodyFontSize: CGFloat = 14
    public static let motionLineSpacing: CGFloat = 4
    public static let userLineSpacing: CGFloat = 2
    public static let motionVerticalPadding: CGFloat = 4
    public static let userVerticalPadding: CGFloat = 2
    /// user 左缩进。实机结论（1996 修正 2）：inset 20 叠加在共享缩进上使起点与输入框不齐，
    /// 已归零——user 仅次级颜色 + 较小字号区分，所有消息与输入文字共享同一 x 起点。
    public static let userLeadingInset: CGFloat = 0

    // MARK: 外层材质与留白（composer 与回复列共享同一左侧光学起点）
    public static let panelCornerRadius: CGFloat = 12
    /// 面板内容与材质边缘的统一留白（水平与垂直同值）。
    public static let contentInset: CGFloat = 10
    /// composer 与回复区之间的节间距。
    public static let sectionSpacing: CGFloat = 4
    /// 回复列的 leading 内边距：与 composer 文字起点对齐（输入文字起点 = contentInset +
    /// composerHorizontalPadding；回复列在 contentInset 基础上再缩进同一值）。
    public static var responseLeadingInset: CGFloat { composerHorizontalPadding }
}
