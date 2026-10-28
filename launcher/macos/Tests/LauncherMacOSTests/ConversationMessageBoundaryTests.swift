import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Phase 2017：独立 Motion messageId 的视觉边界与流式身份稳定性。
final class ConversationMessageBoundaryTests: XCTestCase {
    private func motion(_ id: String, _ text: String) -> Message {
        Message(id: id, role: .motion, text: text, committed: false)
    }

    func testConsecutiveMotionIdsCreateDistinctBoundaries() {
        let user = Message(id: "u1", role: .user, text: "问题", committed: true)
        let groups = makeDialogueGroups([
            user, motion("reply-a", "A1"), motion("reply-b", "B1"), motion("reply-c", "C1"),
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].items.map(\.id), ["u1", "reply-a", "reply-b", "reply-c"])
        XCTAssertEqual(groups[0].items.map(\.boundary), [
            .userStart, .motionContinuation, .motionNewMessage, .motionNewMessage,
        ])
        XCTAssertEqual(groups[0].items.filter { $0.boundary == .motionNewMessage }.count, 2)
        XCTAssertGreaterThan(DialogueComposition.current.motionMessageGap, 0)
    }

    func testStreamingUpsertKeepsIdsAndBoundaryPositions() {
        let user = Message(id: "u1", role: .user, text: "问题", committed: true)
        let initial = makeDialogueGroups([user, motion("reply-a", "A"), motion("reply-b", "B")])
        let streamed = makeDialogueGroups([
            user, motion("reply-a", "A1\nA2\nA3"), motion("reply-b", "B1\nB2"),
        ])
        XCTAssertEqual(streamed.map(\.id), initial.map(\.id))
        XCTAssertEqual(streamed[0].items.map(\.id), initial[0].items.map(\.id))
        XCTAssertEqual(streamed[0].items.map(\.boundary), initial[0].items.map(\.boundary))
    }

    func testNewUserStartsTurnWithoutLosingPreviousMotionBoundaries() {
        let firstUser = Message(id: "u1", role: .user, text: "一", committed: true)
        let secondUser = Message(id: "u2", role: .user, text: "二", committed: true)
        let groups = makeDialogueGroups([
            firstUser, motion("reply-a", "A"), motion("reply-b", "B"), secondUser,
        ])
        XCTAssertEqual(groups.map(\.id), ["u1", "u2"])
        XCTAssertEqual(groups[0].items.map(\.boundary), [.userStart, .motionContinuation, .motionNewMessage])
        XCTAssertEqual(groups[1].items.map(\.boundary), [.userStart])
    }
}
