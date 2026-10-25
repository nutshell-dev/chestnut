import Foundation
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
}
