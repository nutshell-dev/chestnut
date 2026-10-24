import CoreGraphics
import Foundation

/// 三态布局（纯计算，可测；不含 UI 与状态副作用）。
/// owner 边界：ChatView 负责内容测量并上报 response 高度，LauncherPanel 负责窗口 frame；
/// ChatStore/launcher-core 不参与像素计算。
public enum LayoutMode: Equatable, Sendable {
    /// 无消息：仅一行输入框与少量留白。
    case compact
    /// 有消息：输入框固定顶部，回复区按内容增高（未达上限）。
    case expanded
    /// 回复区达到上限：窗口高度固定，仅回复区内部滚动。
    case capped
}

public enum ConversationLayout {
    /// compact 态窗口高度（composer 行 + 留白）。
    public static let compactHeight: CGFloat = 76
    /// 回复区内容高度上限。
    public static let maxResponseHeight: CGFloat = 420
    /// 窗口高度上限 = composer + 回复区上限。
    public static let expandedHeight: CGFloat = compactHeight + maxResponseHeight // 496
    /// 窗口宽度（与 1985 初始宽度一致）。
    public static let width: CGFloat = 640
    /// 高度变化小于该增量时不触发 resize（抑制流式增量抖动）。
    public static let minResizeDelta: CGFloat = 4

    /// compact 判定只看消息有无；expanded/capped 由回复区内容高度决定。
    public static func layoutMode(messageCount: Int, responseHeight: CGFloat) -> LayoutMode {
        guard messageCount > 0 else { return .compact }
        return responseHeight >= maxResponseHeight ? .capped : .expanded
    }

    public static func windowHeight(for mode: LayoutMode, responseHeight: CGFloat) -> CGFloat {
        switch mode {
        case .compact:
            return compactHeight
        case .expanded:
            return min(compactHeight + max(responseHeight, 0), expandedHeight)
        case .capped:
            return expandedHeight
        }
    }

    /// 回复区显示高度：capped 固定上限，否则紧贴内容。
    public static func responseAreaHeight(for mode: LayoutMode, responseHeight: CGFloat) -> CGFloat {
        switch mode {
        case .compact:
            return 0
        case .expanded:
            return min(max(responseHeight, 0), maxResponseHeight)
        case .capped:
            return maxResponseHeight
        }
    }

    /// 高度变化是否值得 resize（小于最小增量则忽略）。
    public static func shouldResize(from current: CGFloat, to target: CGFloat) -> Bool {
        abs(target - current) >= minResizeDelta
    }
}
