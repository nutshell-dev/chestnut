import Foundation
import LauncherCore
import SwiftUI
import XCTest
@testable import LauncherMacOS

/// Phase 2009：同字号单列消息契约——所有角色统一 leading（禁止 trailing）、
/// 正常对话无角色名，user/reply 仅靠语义色、opacity 和垂直节奏区分。
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

    func testUserAndReplyShareTypography() {
        let user = MessageStyle.spec(for: .user)
        let reply = MessageStyle.spec(for: .motion)
        XCTAssertEqual(user.fontSize, 16)
        XCTAssertEqual(reply.fontSize, 16)
        XCTAssertEqual(user.fontSize, reply.fontSize)
        XCTAssertEqual(user.weight, reply.weight)
        XCTAssertEqual(user.lineSpacing, 3)
        XCTAssertEqual(reply.lineSpacing, 3)
        XCTAssertEqual(MessageStyle.opacity(for: .user), 0.82)
        XCTAssertEqual(MessageStyle.opacity(for: .motion), 1)
        XCTAssertGreaterThanOrEqual(MessageStyle.opacity(for: .user), 0.8)
        XCTAssertLessThan(MessageStyle.opacity(for: .user), MessageStyle.opacity(for: .motion))
        // user 次级颜色、Motion 主要颜色
        XCTAssertTrue(MessageStyle.foregroundIsSecondary(for: .user))
        XCTAssertFalse(MessageStyle.foregroundIsSecondary(for: .motion))
        XCTAssertTrue(MessageStyle.foregroundIsSecondary(for: .system))
    }

    func testCompositionOwnsTypographyAndRhythm() {
        let composition = DialogueComposition.current
        XCTAssertEqual(composition.user.fontSize, LauncherVisual.userBodyFontSize)
        XCTAssertEqual(composition.reply.fontSize, LauncherVisual.motionBodyFontSize)
        XCTAssertEqual(composition.user.weight, composition.reply.weight)
        XCTAssertEqual(composition.user.lineSpacing, MessageStyle.lineSpacing(for: .user))
        XCTAssertEqual(composition.reply.lineSpacing, MessageStyle.lineSpacing(for: .motion))
        XCTAssertEqual(composition.firstGroupGap, 12)
        XCTAssertEqual(composition.withinTurnGap, 10)
        XCTAssertEqual(composition.motionMessageGap, 10)
        XCTAssertEqual(composition.motionBoundaryOpacity, 0.10)
        XCTAssertGreaterThan(composition.motionMessageGap, 0)
        XCTAssertGreaterThan(composition.withinTurnGap, 4)
        XCTAssertEqual(composition.betweenTurnsGap, 18)
        XCTAssertGreaterThan(composition.betweenTurnsGap, composition.withinTurnGap)
        XCTAssertEqual(composition.footerGap, 10)
        XCTAssertEqual(MessageStyle.leadingInset(for: .user), MessageStyle.leadingInset(for: .motion))
    }

    func testDialogueGroupsPreserveTurnsAndStreamingIdentity() {
        let firstUser = Message(id: "u1", role: .user, text: "一", committed: true)
        let firstReply = Message(id: "r1", role: .motion, text: "答", committed: false)
        let secondUser = Message(id: "u2", role: .user, text: "二", committed: true)
        let groups = makeDialogueGroups([firstUser, firstReply, secondUser])
        XCTAssertEqual(groups.map(\.id), ["u1", "u2"])
        XCTAssertEqual(groups[0].messages.map(\.id), ["u1", "r1"])
        XCTAssertEqual(groups[1].messages.map(\.id), ["u2"])

        let streamed = Message(id: "r1", role: .motion, text: "答案更长", committed: false)
        XCTAssertEqual(makeDialogueGroups([firstUser, streamed, secondUser]).map(\.id), groups.map(\.id))
        XCTAssertEqual(makeDialogueGroups([firstReply]).map(\.id), ["r1"], "孤立回复也必须可渲染")
    }

    /// 静态颜色契约（phase 2000）：foreground 是纯角色映射——Motion primary、
    /// user/system secondary；无焦点/选择/点击输入，重复调用结果稳定。
    func testForegroundIsStaticRoleMapping() {
        XCTAssertEqual(String(describing: MessageStyle.foreground(for: .motion)), String(describing: Color.primary))
        XCTAssertEqual(String(describing: MessageStyle.foreground(for: .user)), String(describing: Color.secondary))
        XCTAssertEqual(String(describing: MessageStyle.foreground(for: .system)), String(describing: Color.secondary))
        // 纯函数：两次调用等价（不读取任何 UI 状态）
        XCTAssertEqual(
            String(describing: MessageStyle.foreground(for: .motion)),
            String(describing: MessageStyle.foreground(for: .motion))
        )
    }
}
