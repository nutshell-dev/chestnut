import SwiftUI

import LauncherCore

/// 活动行视觉与文案单一来源（phase 2001 引入，phase 2002 按 claw bar 重做，
/// phase 2003 去除 agent 名称）：回复列表底部的单行实时状态。
/// 低干扰：caption 次级色 + 小 spinner；error 保留可见错误行（橙色、无 spinner）；
/// idle 时不渲染、不占高度。
/// wire label 是机器 token（producer 不假设展示文本），此处统一映射为短状态文案；
/// 文案只含短状态与摘要，不含 agent 名称/角色句。
public enum ActivityStyle {
    /// 活动行行高。
    public static let height: CGFloat = 20
    /// spinner 缩放（与 composer 状态槽一致的弱存在感）。
    public static let spinnerScale: CGFloat = 0.5

    /// 活动行显示文本；idle 返回 nil（不渲染）。
    /// processing 摘要呈现与 viewport claw bar（buildClawLine）同规则：
    /// thinking 摘要圆括号、裸文本摘要双引号、工具只显示短名（spinner 已表活动，不加 ⚙）；
    /// 其余短状态统一 thinking…/streaming…（无 agent 名称）。
    public static func text(for activity: ActivityState) -> String? {
        switch activity {
        case .idle:
            return nil
        case .waiting:
            return "thinking…"
        case .responding:
            return "streaming…"
        case let .processing(label, detail):
            let trimmed = detail?.isEmpty == false ? detail : nil
            switch label {
            case "thinking":
                if let trimmed { return "(\(trimmed))" } // claw: (thinking buffer)
                return "thinking…"
            case "text":
                if let trimmed { return "\"\(trimmed)\"" } // claw: "text buffer"
                return "thinking…"
            case "tool", "tool_result":
                if let trimmed { return trimmed } // claw: currentTool 短名（spinner 已表活动）
                return "tool…"
            default: // provider/turn/未知 token：统一短状态，token 不上屏
                return "thinking…"
            }
        case let .error(detail):
            // phase 2003 Step E：error detail 是 claw bar 共享 formatter 的输出，
            // 原样显示——不添加中文前缀、不拼接角色名、不改写。
            if let detail, !detail.isEmpty { return detail }
            return "error"
        }
    }

    /// error 态无 spinner（终态不假装进行中）、用橙色区分正常活动（claw ✗ 语义）。
    public static func isError(_ activity: ActivityState) -> Bool {
        if case .error = activity { return true }
        return false
    }
}
