import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Phase 2001 引入、Phase 2002 按 claw bar 重做：活动行文本与占位规则——单行、低干扰、idle 不占位；
/// wire label token 统一映射中文短文案，未知 token 只显示通用文案；error 保留可读错误行。
final class ActivityBarTests: XCTestCase {
    func testIdleHasNoActivityLine() {
        XCTAssertNil(ActivityStyle.text(for: .idle), "idle 时不渲染活动行、不占高度")
    }

    func testWaitingShowsProcessingPlaceholder() {
        XCTAssertEqual(ActivityStyle.text(for: .waiting), "Motion 正在处理…")
    }

    func testRespondingText() {
        XCTAssertEqual(ActivityStyle.text(for: .responding), "Motion 正在回复…")
    }

    func testProcessingLabelMapping() {
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "thinking", detail: nil)),
            "Motion 正在处理 · 思考…"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "tool", detail: "search")),
            "Motion 正在处理 · 工具 · search…"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "tool_result", detail: "search")),
            "Motion 正在处理 · 工具完成 · search…"
        )
    }

    func testUnknownLabelFallsBackToGenericText() {
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "telemetry_v2", detail: nil)),
            "Motion 正在处理…",
            "未知 label token 不直接上屏"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: nil, detail: nil)),
            "Motion 正在处理…"
        )
    }

    // MARK: phase 2002 claw bar 文案与 error

    func testProviderAndTextLabelMapping() {
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "provider", detail: "kimi")),
            "Motion 正在处理 · 调用模型 · kimi…"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "text", detail: "起草正文")),
            "Motion 正在处理 · 起草 · 起草正文…"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "thinking", detail: "先想 第一步")),
            "Motion 正在处理 · 思考 · 先想 第一步…",
            "thinking 累计摘要（单行净化）随 detail 上屏"
        )
    }

    /// error 保留可读错误行（claw lastError 语义）：文案可见、isError 标记驱动无 spinner/橙色。
    func testErrorActivityTextAndFlag() {
        XCTAssertEqual(
            ActivityStyle.text(for: .error(detail: "LLM 网络失败 provider kimi 不可用")),
            "Motion 出错：LLM 网络失败 provider kimi 不可用"
        )
        XCTAssertEqual(ActivityStyle.text(for: .error(detail: nil)), "Motion 出错")
        XCTAssertTrue(ActivityStyle.isError(.error(detail: "x")))
        XCTAssertFalse(ActivityStyle.isError(.processing(label: "tool", detail: nil)))
        XCTAssertFalse(ActivityStyle.isError(.idle))
    }

    /// 行高 token 存在且克制（单行量级，不撑爆 compact 布局）。
    func testActivityLineHeightToken() {
        XCTAssertEqual(ActivityStyle.height, 20)
        XCTAssertLessThan(ActivityStyle.height, LauncherVisual.composerHeight)
    }
}
