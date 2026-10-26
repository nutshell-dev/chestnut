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
    /// processing 摘要呈现与 viewport claw bar（buildClawLine）完全同规则，不另设第二套：
    /// thinking 摘要圆括号包裹、裸文本摘要双引号包裹、工具 ⚙ + 短名；无摘要时退回短状态。
    public static func text(for activity: ActivityState) -> String? {
        switch activity {
        case .idle:
            return nil
        case .waiting:
            return "正在处理…"
        case .responding:
            return "正在回复…"
        case let .processing(label, detail):
            let trimmed = detail?.isEmpty == false ? detail : nil
            switch label {
            case "thinking":
                if let trimmed { return "(\(trimmed))" } // claw: (thinking buffer)
                return "思考…"
            case "text":
                if let trimmed { return "\"\(trimmed)\"" } // claw: "text buffer"
                return "正在处理…"
            case "tool", "tool_result":
                if let trimmed { return "⚙ \(trimmed)" } // claw: ⚙ currentTool
                return "工具…"
            case "provider":
                if let trimmed { return "调用模型 · \(trimmed)…" }
                return "调用模型…"
            default: // turn / 未知 token：通用短状态，token 不上屏
                return "正在处理…"
            }
        case let .error(detail):
            // claw bar lastError 语义：错误保留可见，直到下一次发送
            if let detail, !detail.isEmpty { return "出错：\(detail)" }
            return "出错"
        }
    }

    /// error 态无 spinner（终态不假装进行中）、用橙色区分正常活动（claw ✗ 语义）。
    public static func isError(_ activity: ActivityState) -> Bool {
        if case .error = activity { return true }
        return false
    }
}
