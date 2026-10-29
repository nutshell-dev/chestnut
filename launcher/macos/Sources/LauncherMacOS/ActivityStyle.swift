import SwiftUI

import LauncherCore

/// 活动行视觉与文案单一来源（phase 2001 引入，phase 2002 按 claw bar 重做，
/// phase 2003 去除 agent 名称，phase 2004 提升普通活动视觉层级并集中 token）：
/// 回复列表底部的单行实时状态。普通活动 14pt regular、secondary × opacity、
/// spinner 表进行中；error 保留可见错误行（橙色、无 spinner、不套 opacity）；
/// idle 时不渲染、不占高度。
/// wire label 是机器 token（producer 不假设展示文本），此处统一映射为短状态文案；
/// 静态短词首字母大写（Thinking…/Streaming…/Tool…）；动态内容（摘要/工具短名/
/// wire detail）一律不改写。文案只含短状态与摘要，不含 agent 名称/角色句。
public enum ActivityStyle {
    // MARK: 视觉 token（phase 2004：普通活动行全部视觉数值单源；ChatView 只消费）
    /// 字号（显式 system size，不依赖 caption 动态默认；低于正文 16pt）。
    public static let fontSize: CGFloat = 14
    /// 行高（phase 2004：20→22，随字号提升；计入 ChatView 窗口高度记账）。
    public static let lineHeight: CGFloat = 22
    /// 普通活动文字不透明度（secondary × 0.75：清晰但不抢正文；错误行不套）。
    public static let opacity: Double = 0.75
    /// response → activityBar 顶距（phase 2004 Step C：从 LauncherVisual 移入——
    /// activity 行视觉 token 归本类型，LauncherVisual 只拥有窗口/section 几何）。
    public static let topGap: CGFloat = 8
    /// spinner 缩放（与 composer 状态槽一致的弱存在感）。
    public static let spinnerScale: CGFloat = 0.5
    /// 错误图标字号（略小于行文字，共用 baseline 视觉）。
    public static let errorIconSize: CGFloat = 12

    /// spinner 语义单源（phase 2004 Step C）：普通活动有 spinner；错误族无 spinner
    /// （终态/中间态都不假装进行中）。idle 不渲染，返回值无意义。
    public static func showsSpinner(_ activity: ActivityState) -> Bool {
        !isError(activity)
    }

    /// 活动行显示文本；idle 返回 nil（不渲染）。
    /// processing 摘要呈现与 viewport claw bar（buildClawLine）同规则：
    /// thinking 摘要圆括号、裸文本摘要双引号、工具只显示短名（spinner 已表活动，不加 ⚙）；
    /// 静态短状态统一 Thinking…/Streaming…（phase 2004 首字母大写，无 agent 名称）。
    public static func text(for activity: ActivityState,
                            semantics: LauncherUiSemantics? = nil) -> String? {
        func state(_ id: String) -> String { SetupCopy.state(id, semantics: semantics).label }
        switch activity {
        case .idle:
            return nil
        case .waiting:
            return state("activity.waiting")
        case .responding:
            return state("activity.responding")
        case let .processing(label, detail):
            let trimmed = detail?.isEmpty == false ? detail : nil
            switch label {
            case "thinking":
                if let trimmed { return "(\(trimmed))" } // claw: (thinking buffer)
                return state("activity.thinking")
            case "text":
                if let trimmed { return "\"\(trimmed)\"" } // claw: "text buffer"
                return state("activity.thinking")
            case "tool", "tool_result":
                if let trimmed { return trimmed } // claw: currentTool 短名（spinner 已表活动）
                return state("activity.tool")
            default: // provider/turn/未知 token：统一短状态，token 不上屏
                return state("activity.thinking")
            }
        case let .error(detail):
            // 错误族 detail 是协议输出的最终显示文本（TS 共享 formatter），
            // 原样显示——不添加前缀、不拼接角色名、不改写；Swift 不持有 claw bar 符号词汇。
            if let detail, !detail.isEmpty { return detail }
            return state("activity.error")
        case let .interrupted(detail):
            if let detail, !detail.isEmpty { return detail }
            return state("activity.interrupted")
        case let .retry(detail):
            // retry 是可恢复中间态：原样显示 wire detail，不当普通 error 文案
            if let detail, !detail.isEmpty { return detail }
            return state("activity.retry")
        case let .blocked(detail):
            if let detail, !detail.isEmpty { return detail }
            return state("activity.blocked")
        }
    }

    /// error 态标记（无 spinner、橙色）：错误族全部保留可见，终态/中间态都不假装进行中。
    public static func isError(_ activity: ActivityState) -> Bool {
        switch activity {
        case .error, .interrupted, .retry, .blocked: return true
        default: return false
        }
    }
}
