import Foundation
import XCTest
@testable import LauncherMacOS

/// Step C：三态布局纯计算。锁定 compact/expanded/capped 模式判定、
/// 窗口高度上限（capped = 496）、回复区高度与最小 resize 增量。
final class ConversationLayoutTests: XCTestCase {
    func testCompactWhenNoMessages() {
        XCTAssertEqual(ConversationLayout.layoutMode(messageCount: 0, responseHeight: 0), .compact)
        XCTAssertEqual(ConversationLayout.layoutMode(messageCount: 0, responseHeight: 500), .compact)
        XCTAssertEqual(ConversationLayout.windowHeight(for: .compact, responseHeight: 0), 76)
    }

    func testExpandedGrowsWithContentBelowCap() {
        XCTAssertEqual(ConversationLayout.layoutMode(messageCount: 1, responseHeight: 100), .expanded)
        XCTAssertEqual(ConversationLayout.windowHeight(for: .expanded, responseHeight: 100), 176)
        // 未达上限时窗口 = composer + 内容
        XCTAssertEqual(ConversationLayout.windowHeight(for: .expanded, responseHeight: 419), 495)
    }

    func testCappedAtMaxResponseHeight() {
        XCTAssertEqual(ConversationLayout.layoutMode(messageCount: 3, responseHeight: 420), .capped)
        XCTAssertEqual(ConversationLayout.layoutMode(messageCount: 3, responseHeight: 1600), .capped)
    }

    /// 长流式回复：窗口高度稳定在上限，不随内容无限增高（也不裁剪消息——滚动语义由回复区承担）。
    func testLongStreamCapsWindowHeight() {
        XCTAssertEqual(ConversationLayout.windowHeight(for: .capped, responseHeight: 1600), 496)
        XCTAssertEqual(ConversationLayout.windowHeight(for: .capped, responseHeight: 420), 496)
        // expanded 传入异常超大内容也被钳制在上限
        XCTAssertEqual(ConversationLayout.windowHeight(for: .expanded, responseHeight: 10000), 496)
    }

    func testResponseAreaHeight() {
        XCTAssertEqual(ConversationLayout.responseAreaHeight(for: .compact, responseHeight: 0), 0)
        XCTAssertEqual(ConversationLayout.responseAreaHeight(for: .expanded, responseHeight: 100), 100)
        XCTAssertEqual(ConversationLayout.responseAreaHeight(for: .capped, responseHeight: 1600), 420)
    }

    func testResponseAreaHeightRejectsNegativeInputs() {
        XCTAssertEqual(ConversationLayout.responseAreaHeight(for: .expanded, responseHeight: -1), 0)
        XCTAssertEqual(ConversationLayout.responseAreaHeight(for: .expanded, responseHeight: -1, footerHeight: 30), 0)
        XCTAssertEqual(ConversationLayout.responseAreaHeight(for: .capped, responseHeight: -1, footerHeight: -1), 420)
    }

    func testFooterContributionIsBoundedAndOnlyAffectsCappedResponseArea() {
        XCTAssertEqual(
            ConversationLayout.responseAreaHeight(for: .expanded, responseHeight: 100, footerHeight: 30),
            100
        )
        XCTAssertEqual(
            ConversationLayout.responseAreaHeight(for: .expanded, responseHeight: 420, footerHeight: 30),
            390,
            "近顶界时 expanded 也必须提前为 footer 让位"
        )
        XCTAssertEqual(
            ConversationLayout.responseAreaHeight(for: .capped, responseHeight: 1600, footerHeight: 30),
            390
        )
        XCTAssertEqual(
            ConversationLayout.responseAreaHeight(for: .capped, responseHeight: 1600, footerHeight: 1000),
            0
        )
        XCTAssertEqual(
            ConversationLayout.responseAreaHeight(for: .capped, responseHeight: 1600, footerHeight: -1),
            420
        )
    }

    /// 小于最小增量的高度变化不触发 resize（抑制流式增量抖动）。
    func testMinResizeDeltaSuppressesJitter() {
        XCTAssertFalse(ConversationLayout.shouldResize(from: 100, to: 103))
        XCTAssertTrue(ConversationLayout.shouldResize(from: 100, to: 104))
        XCTAssertTrue(ConversationLayout.shouldResize(from: 496, to: 76))
    }
}
