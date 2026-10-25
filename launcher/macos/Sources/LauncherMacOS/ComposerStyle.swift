import CoreGraphics
import SwiftUI

/// Spotlight/Raycast 风格输入区视觉单一来源（phase 1990 Step C；phase 1996 起数值转发自
/// LauncherVisual）。只含几何常量；行为（提交/绑定）归 ChatView。
/// composer 无独立表面：1990/1991 两次实机均否决独立材质/边框（框中框）；
/// focus 只用系统文本焦点，不画第二个框。
public enum ComposerStyle {
    /// 输入栏固定高度（busy 状态不改变高度，防抖动）。
    public static var height: CGFloat { LauncherVisual.composerHeight }
    public static let cornerRadius: CGFloat = 16
    public static var horizontalPadding: CGFloat { LauncherVisual.composerHorizontalPadding }
    /// 右侧忙碌状态槽预留宽度（ProgressView 出现/消失不改变布局）。
    public static var statusSlotWidth: CGFloat { LauncherVisual.statusSlotWidth }
    public static var fontSize: CGFloat { LauncherVisual.composerFontSize }
    public static var placeholder: String { LauncherVisual.placeholder }

    public static var font: Font { .system(size: fontSize, weight: .regular) }
}
