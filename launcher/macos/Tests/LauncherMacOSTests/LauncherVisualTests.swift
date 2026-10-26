import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Phase 1996：单列视觉契约——克制尺寸（1991 放大已否决）、composer 无独立表面、
/// user 轻微 inset 不构成第二栏、composer 与回复列共享左侧光学起点。
final class LauncherVisualTests: XCTestCase {
    func testOpticalScaleTokens() {
        XCTAssertEqual(LauncherVisual.panelWidth, 640)
        XCTAssertEqual(LauncherVisual.compactHeight, 76)
        XCTAssertEqual(LauncherVisual.composerHeight, 54)
        XCTAssertEqual(LauncherVisual.composerFontSize, 17)
        XCTAssertEqual(LauncherVisual.responseMaxWidth, 560)
        XCTAssertEqual(LauncherVisual.responseMaxHeight, 420)
        XCTAssertEqual(LauncherVisual.motionBodyFontSize, 16)
        XCTAssertEqual(LauncherVisual.motionLineSpacing, 4)
    }

    /// 单源一致性：行为层/输入层读到的值必须等于 token 源（防双源漂移）。
    func testSingleSourceConsistency() {
        XCTAssertEqual(ConversationLayout.width, LauncherVisual.panelWidth)
        XCTAssertEqual(ConversationLayout.compactHeight, LauncherVisual.compactHeight)
        XCTAssertEqual(ConversationLayout.maxResponseHeight, LauncherVisual.responseMaxHeight)
        XCTAssertEqual(ComposerStyle.height, LauncherVisual.composerHeight)
        XCTAssertEqual(ComposerStyle.fontSize, LauncherVisual.composerFontSize)
        XCTAssertEqual(ComposerStyle.placeholder, LauncherVisual.placeholder)
    }

    /// phase 2008：不再有 user 专属 inset，所有角色共享 response 内容轴。
    func testMessagesShareResponseLeadingEdge() {
        XCTAssertEqual(LauncherVisual.messageLeadingInset, LauncherVisual.responseLeadingInset)
        XCTAssertEqual(MessageStyle.leadingInset(for: .user), MessageStyle.leadingInset(for: .motion))
    }

    /// 阅读宽度明显窄于面板内容宽（回复不铺满，留出呼吸边界）。
    func testResponseWidthLeavesMargin() {
        let contentWidth = LauncherVisual.panelWidth - 2 * LauncherVisual.contentInset
        XCTAssertLessThan(LauncherVisual.responseMaxWidth, contentWidth)
        XCTAssertGreaterThan(LauncherVisual.responseMaxWidth, contentWidth - 120)
    }

    /// composer 无独立表面契约：token 层只定义几何，不含 fill/border/shadow；
    /// 外层只有单一材质圆角 token。
    func testSinglePanelSurface() {
        XCTAssertEqual(LauncherVisual.panelCornerRadius, 12)
        XCTAssertEqual(LauncherVisual.contentInset, 10)
        XCTAssertEqual(ComposerStyle.horizontalPadding, LauncherVisual.composerHorizontalPadding)
        XCTAssertEqual(ComposerStyle.statusSlotWidth, LauncherVisual.statusSlotWidth)
    }

    /// 共享左侧光学起点：回复列 leading 缩进必须等于 composer 水平内边距——
    /// 输入文字与回复文本从同一 x 开始（实机曾发现回复顶到材质边缘）。
    func testResponseColumnSharesComposerLeadingEdge() {
        XCTAssertEqual(LauncherVisual.responseLeadingInset, LauncherVisual.composerHorizontalPadding)
        XCTAssertGreaterThan(LauncherVisual.responseLeadingInset, 0)
        // 阅读列右端不超出内容区
        let contentWidth = LauncherVisual.panelWidth - 2 * LauncherVisual.contentInset
        XCTAssertLessThanOrEqual(
            LauncherVisual.responseLeadingInset + LauncherVisual.responseMaxWidth,
            contentWidth
        )
    }

    /// phase 2008：组内/组间/footer 只由 DialogueComposition 拥有。
    func testDialogueCompositionMetricsAreExplicit() {
        let composition = DialogueComposition.current
        XCTAssertEqual(composition.firstGroupGap, 4)
        XCTAssertEqual(composition.withinTurnGap, 4)
        XCTAssertEqual(composition.betweenTurnsGap, 16)
        XCTAssertEqual(composition.footerGap, 8)
        XCTAssertGreaterThan(composition.betweenTurnsGap, composition.withinTurnGap)
    }

    /// 颜色稳定结构契约（phase 2000）：ChatView 全文无 textSelection（隐式选择/焦点渲染
    /// 是黑灰串扰来源，phase1999 实机证伪后整体移除）；MessageStyle 暴露 foreground(for:)
    /// 纯角色映射，Motion 主要色、user 次级色。
    func testNoSelectionSurfaceAndStableColorTokens() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // LauncherMacOSTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // macos
            .appendingPathComponent("Sources/LauncherMacOS/ChatView.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(source.contains(".textSelection("), "ChatView 不得声明 textSelection（phase 2000）")
        XCTAssertFalse(MessageStyle.foregroundIsSecondary(for: .motion), "Motion 保持主要颜色")
        XCTAssertTrue(MessageStyle.foregroundIsSecondary(for: .user), "user 保持次级颜色")
    }
}
