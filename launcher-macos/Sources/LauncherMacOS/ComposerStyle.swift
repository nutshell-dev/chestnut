import CoreGraphics
import SwiftUI

/// Spotlight/Raycast 风格输入区视觉单一来源（phase 1990 Step C）。
/// 只含几何与颜色常量；行为（提交/绑定）归 ChatView。
public enum ComposerStyle {
    /// 输入栏固定高度（busy 状态不改变高度，防抖动）。
    public static let height: CGFloat = 54
    public static let cornerRadius: CGFloat = 16
    public static let horizontalPadding: CGFloat = 18
    /// 右侧忙碌状态槽预留宽度（ProgressView 出现/消失不改变布局）。
    public static let statusSlotWidth: CGFloat = 20
    public static let fontSize: CGFloat = 17
    public static let borderOpacity: Double = 0.16
    public static let placeholder: String = "询问 Motion…"

    public static var font: Font { .system(size: fontSize, weight: .regular) }

    /// 细边框：系统语义白透明度，深浅模式自适应。
    public static var border: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(.white.opacity(borderOpacity))
    }

    public static var backgroundShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }
}
