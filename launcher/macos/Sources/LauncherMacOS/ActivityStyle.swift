import SwiftUI

import LauncherCore

/// 活动行视觉与文案单一来源（phase 2001 引入，phase 2002 按 claw bar 重做）：回复列表底部
/// 的单行实时状态。低干扰：caption 次级色 + 小 spinner；error 保留可见错误行（橙色、无 spinner）；
/// idle 时不渲染、不占高度。
/// wire label 是机器 token（producer 不假设展示文本），此处统一映射为中文短文案。
public enum ActivityStyle {
    /// 活动行行高。
    public static let height: CGFloat = 20
    /// spinner 缩放（与 composer 状态槽一致的弱存在感）。
    public static let spinnerScale: CGFloat = 0.5

    /// 活动行显示文本；idle 返回 nil（不渲染）。
    public static func text(for activity: ActivityState) -> String? {
        switch activity {
        case .idle:
            return nil
        case .waiting:
            return "Motion 正在处理…"
        case .responding:
            return "Motion 正在回复…"
        case let .processing(label, detail):
            var parts = ["Motion 正在处理"]
            if let token = labelTokenText(label) { parts.append(token) }
            if let detail, !detail.isEmpty { parts.append(detail) }
            return parts.joined(separator: " · ") + "…"
        case let .error(detail):
            // claw bar lastError 语义：错误保留可见，直到下一次发送
            if let detail, !detail.isEmpty { return "Motion 出错：\(detail)" }
            return "Motion 出错"
        }
    }

    /// error 态无 spinner（终态不假装进行中）、用橙色区分正常活动（claw ✗ 语义）。
    public static func isError(_ activity: ActivityState) -> Bool {
        if case .error = activity { return true }
        return false
    }

    /// wire label token → 中文短文案；未知 token 忽略（只显示通用"正在处理"）。
    private static func labelTokenText(_ label: String?) -> String? {
        switch label {
        case "turn": return nil // turn 开始本身无增量信息
        case "provider": return "调用模型"
        case "thinking": return "思考"
        case "text": return "起草"
        case "tool": return "工具"
        case "tool_result": return "工具完成"
        default: return nil
        }
    }
}
