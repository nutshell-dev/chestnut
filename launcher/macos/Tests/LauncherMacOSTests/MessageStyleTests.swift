import Foundation
import LauncherCore
import SwiftUI
import XCTest
@testable import LauncherMacOS

/// Phase 1996 Step B/D：单列消息契约——所有角色统一 leading（禁止 trailing）、
/// 正常对话无角色名、user 仅靠 inset/颜色/字号一级差异区分。
final class MessageStyleTests: XCTestCase {
    private func message(_ role: Message.Role, committed: Bool = true) -> Message {
        Message(id: "m1", role: role, text: "你好", committed: committed)
    }

    /// 统一左侧单列：所有角色 text alignment 均为 leading（Alignment 不可比较，
    /// frame alignment 的 leading 语义由本测试 + messageRow 的固定 .leading 调用共同锁定）。
    func testAllRolesUseLeadingColumn() {
        XCTAssertEqual(MessageStyle.textAlignment(for: .user), .leading, "user 不再右对齐（1993 已否决）")
        XCTAssertEqual(MessageStyle.textAlignment(for: .motion), .leading)
        XCTAssertEqual(MessageStyle.textAlignment(for: .system), .leading)
        // 所有角色 inset 均为 0：与输入框共享同一左侧起点（1996 实机修正）
        XCTAssertEqual(MessageStyle.leadingInset(for: .user), 0)
        XCTAssertEqual(MessageStyle.leadingInset(for: .motion), 0)
        XCTAssertEqual(MessageStyle.leadingInset(for: .system), 0)
    }

    func testNoRoleLabelsInNormalConversation() {
        XCTAssertFalse(MessageStyle.showsRoleLabel(for: message(.motion)), "Motion 回复不显示角色名")
        XCTAssertFalse(MessageStyle.showsRoleLabel(for: message(.user)), "用户消息不显示角色名")
        XCTAssertFalse(MessageStyle.showsRoleLabel(for: message(.motion, committed: false)), "流式中的 Motion 消息同样无标签")
        XCTAssertTrue(MessageStyle.showsRoleLabel(for: message(.system)), "system 消息保留标签解释来源")
    }

    func testTypographyHierarchy() {
        XCTAssertEqual(LauncherVisual.motionBodyFontSize, 16)
        XCTAssertEqual(LauncherVisual.userBodyFontSize, 14)
        XCTAssertGreaterThan(LauncherVisual.motionBodyFontSize, LauncherVisual.userBodyFontSize)
        XCTAssertGreaterThan(MessageStyle.lineSpacing(for: .motion), MessageStyle.lineSpacing(for: .user))
        XCTAssertGreaterThan(MessageStyle.blockPadding(for: .motion), MessageStyle.blockPadding(for: .user))
        // user 次级颜色、Motion 主要颜色
        XCTAssertTrue(MessageStyle.foregroundIsSecondary(for: .user))
        XCTAssertFalse(MessageStyle.foregroundIsSecondary(for: .motion))
        XCTAssertTrue(MessageStyle.foregroundIsSecondary(for: .system))
    }
}
