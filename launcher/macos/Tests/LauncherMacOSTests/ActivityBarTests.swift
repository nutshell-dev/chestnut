import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Phase 2001 引入、Phase 2002 按 claw bar 重做、Phase 2003 去 agent 名称：
/// 活动行文本与占位规则——单行、低干扰、idle 不占位；
/// wire label token 统一映射短状态文案，未知 token 只显示通用文案；
/// error 保留可读错误行；所有文案不含 agent 名称/角色句。
final class ActivityBarTests: XCTestCase {
    func testIdleHasNoActivityLine() {
        XCTAssertNil(ActivityStyle.text(for: .idle), "idle 时不渲染活动行、不占高度")
    }

    func testWaitingShowsProcessingPlaceholder() {
        XCTAssertEqual(ActivityStyle.text(for: .waiting), "Thinking…")
    }

    func testRespondingText() {
        XCTAssertEqual(ActivityStyle.text(for: .responding), "Streaming…")
    }

    /// 摘要呈现与 viewport claw bar 同规则：thinking 圆括号、裸文本双引号、
    /// 工具只显示短名（spinner 已表活动，不加 ⚙）；静态短词首字母大写（phase 2004）。
    func testProcessingLabelMapping() {
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "thinking", detail: nil)),
            "Thinking…"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "tool", detail: "search")),
            "search"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "tool_result", detail: "search")),
            "search"
        )
        // tool 无 detail 兑底也是静态短词，同享首字母大写
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "tool", detail: nil)),
            "Tool…"
        )
    }

    func testUnknownLabelFallsBackToGenericText() {
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "telemetry_v2", detail: nil)),
            "Thinking…",
            "未知 label token 不直接上屏"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: nil, detail: nil)),
            "Thinking…"
        )
    }

    // MARK: phase 2002/2003 claw bar 摘要与 error

    func testProviderAndTextLabelMapping() {
        // provider/turn 等统一短状态 Thinking…（phase 2004 首字母大写）
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "provider", detail: "kimi")),
            "Thinking…"
        )
        // 裸文本双引号包裹（claw bar 同规则），无 label 词
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "text", detail: "起草正文")),
            "\"起草正文\""
        )
        // thinking 圆括号包裹（claw bar 同规则），摘要为单行净化累计
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "thinking", detail: "先想 第一步")),
            "(先想 第一步)"
        )
    }

    /// error detail 原样显示（phase 2003 Step E）：wire detail 是 claw bar 共享 formatter
    /// 的输出（含 [id] ✗ 前缀），UI 不追加中文前缀、不拼接角色名、不改写。
    func testErrorActivityTextAndFlag() {
        XCTAssertEqual(
            ActivityStyle.text(for: .error(detail: "[motion] ✗ LLM 网络失败 provider kimi 不可用")),
            "[motion] ✗ LLM 网络失败 provider kimi 不可用"
        )
        XCTAssertEqual(ActivityStyle.text(for: .error(detail: nil)), "error")
        XCTAssertTrue(ActivityStyle.isError(.error(detail: "x")))
        XCTAssertFalse(ActivityStyle.isError(.processing(label: "tool", detail: nil)))
        XCTAssertFalse(ActivityStyle.isError(.idle))
    }

    // MARK: phase 2003 Step F 错误族原样显示

    /// retry/blocked/interrupted 与 error 同一显示路径：wire detail（claw bar 共享 formatter
    /// 输出）原样显示，retry 不当普通 error 文案；全部错误族无 spinner、标 error 色。
    func testErrorFamilyDisplayedVerbatim() {
        let cases: [(ActivityState, String)] = [
            (.interrupted(detail: "[motion] ✗ interrupted"), "[motion] ✗ interrupted"),
            (.retry(detail: "[motion] ⟳ context exceeded · retrying (2/5, 4s)"), "[motion] ⟳ context exceeded · retrying (2/5, 4s)"),
            (.blocked(detail: "[motion] ⏸ context blocked (retry_exhausted)"), "[motion] ⏸ context blocked (retry_exhausted)"),
        ]
        for (state, expected) in cases {
            XCTAssertEqual(ActivityStyle.text(for: state), expected, "\(state) 必须原样显示 wire detail")
            XCTAssertTrue(ActivityStyle.isError(state), "\(state) 属错误族：无 spinner、橙色")
        }
        // 缺 detail 的兜底短文案（phase 2004：Swift 不持有 claw bar 符号词汇，兜底为纯词）
        XCTAssertEqual(ActivityStyle.text(for: .interrupted(detail: nil)), "interrupted")
        XCTAssertEqual(ActivityStyle.text(for: .retry(detail: nil)), "retrying")
        XCTAssertEqual(ActivityStyle.text(for: .blocked(detail: nil)), "blocked")
    }

    // MARK: phase 2003 无 agent 名称

    /// 状态文案只含短状态 key 与安全摘要，不含 agent 名称或固定角色句（phase 2003 边界）。
    func testStatusTextContainsNoAgentName() {
        let states: [ActivityState] = [
            .waiting,
            .responding,
            .processing(label: "turn", detail: nil),
            .processing(label: "thinking", detail: "摘要"),
            .processing(label: "tool", detail: "search"),
            .processing(label: "provider", detail: "kimi"),
            .error(detail: "网络失败"),
            .error(detail: nil),
        ]
        for state in states {
            guard let text = ActivityStyle.text(for: state) else { continue }
            XCTAssertFalse(text.contains("Motion"), "状态文案不得含 agent 名称：\(text)")
            XCTAssertFalse(text.contains("claw"), "状态文案不得含 claw 名：\(text)")
            XCTAssertFalse(text.contains("\n"), "状态文案必须单行：\(text)")
        }
    }

    /// 视觉 token 单源（phase 2004）：字号显式 14pt（低于正文 16pt、不依赖 caption
    /// 动态默认）、行高 22（计入窗口高度记账，仍低于 composer）、普通文字 0.75 不透明度、
    /// 顶距 8；数值集中在 ActivityStyle，ChatView 不得散落。
    func testActivityVisualTokens() {
        XCTAssertEqual(ActivityStyle.fontSize, 14)
        XCTAssertLessThan(ActivityStyle.fontSize, LauncherVisual.motionBodyFontSize)
        XCTAssertEqual(ActivityStyle.lineHeight, 22)
        XCTAssertLessThan(ActivityStyle.lineHeight, LauncherVisual.composerHeight)
        XCTAssertEqual(ActivityStyle.opacity, 0.75)
        XCTAssertEqual(ActivityStyle.topGap, 8)
    }

    /// spinner 语义单源（phase 2004 Step C）：普通活动有 spinner；错误族全部无 spinner。
    func testShowsSpinnerSemantics() {
        XCTAssertTrue(ActivityStyle.showsSpinner(.waiting))
        XCTAssertTrue(ActivityStyle.showsSpinner(.responding))
        XCTAssertTrue(ActivityStyle.showsSpinner(.processing(label: "tool", detail: "search")))
        XCTAssertFalse(ActivityStyle.showsSpinner(.error(detail: "x")))
        XCTAssertFalse(ActivityStyle.showsSpinner(.interrupted(detail: nil)))
        XCTAssertFalse(ActivityStyle.showsSpinner(.retry(detail: nil)))
        XCTAssertFalse(ActivityStyle.showsSpinner(.blocked(detail: nil)))
    }
}
