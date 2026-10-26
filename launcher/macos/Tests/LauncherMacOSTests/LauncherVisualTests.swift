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

    /// user inset 实机归零：所有角色与输入框共享同一左侧起点（1996 修正 2）。
    /// inset 语义保留为 token，防止后续无实机证据重新引入缩进。
    func testUserInsetIsZero() {
        XCTAssertEqual(LauncherVisual.userLeadingInset, 0)
        XCTAssertLessThanOrEqual(LauncherVisual.userLeadingInset, LauncherVisual.responseMaxWidth * 0.05)
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

    /// section metrics（phase 1998）：间距可解释且与 1996 实机通过版等效——
    /// composer→response 4；response→status 8（原 sectionSpacing 4 + statusLine 魔数 4）。
    func testSectionMetricsAreExplicit() {
        XCTAssertEqual(LauncherVisual.composerToResponseGap, 4)
        XCTAssertEqual(LauncherVisual.responseToStatusGap, 8)
    }

    /// 底部活动行间距 token（phase 2002 引入；phase 2004 Step C 移归 ActivityStyle——
    /// activity 行视觉 token 单源化，LauncherVisual 只拥有窗口/section 几何）。
    func testActivityTopGapToken() {
        XCTAssertEqual(ActivityStyle.topGap, 8)
    }

    /// 消息块节奏单源化（phase 1998）：内容栈 spacing 归零后，块间距全由 blockPadding 承担；
    /// 等效换算锁定：motion 7 / user 5（原 spacing 6 均摊 3 + verticalPadding 4/2），
    /// 任意相邻两块间隔保持 1996 实机通过值（motion-motion 14 / user-user 10 / 混合 12）。
    func testBlockRhythmEquivalence() {
        XCTAssertEqual(LauncherVisual.motionBlockPadding, 7)
        XCTAssertEqual(LauncherVisual.userBlockPadding, 5)
        XCTAssertEqual(2 * LauncherVisual.motionBlockPadding, 14)
        XCTAssertEqual(2 * LauncherVisual.userBlockPadding, 10)
        XCTAssertEqual(LauncherVisual.motionBlockPadding + LauncherVisual.userBlockPadding, 12)
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
