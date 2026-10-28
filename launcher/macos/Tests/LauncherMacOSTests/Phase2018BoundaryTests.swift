import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Phase 2018：结构分隔、非交互提示与安全字段配置的综合边界。
final class Phase2018BoundaryTests: XCTestCase {
    func testMotionBoundaryDependsOnlyOnMessageIdNotNewlines() throws {
        let user = Message(id: "u1", role: .user, text: "问题", committed: true)
        let first = Message(id: "reply-a", role: .motion, text: "第一行\n第二行\n\n第三行", committed: false)
        let second = Message(id: "reply-b", role: .motion, text: "下一条", committed: false)
        let group = makeDialogueGroups([user, first, second])[0]
        XCTAssertEqual(group.items.map(\.boundary), [.userStart, .motionContinuation, .motionNewMessage])
        XCTAssertEqual(group.items.filter { $0.boundary == .motionNewMessage }.count, 1)
        XCTAssertEqual(group.items[1].message.text, first.text)

        let source = try sourceFile("ChatView.swift")
        XCTAssertTrue(source.contains("Rectangle()"))
        XCTAssertTrue(source.contains("composition.motionBoundaryOpacity"))
        XCTAssertTrue(source.contains("item.boundary == .motionNewMessage"))
        XCTAssertFalse(source.contains("message.text.components(separatedBy"))
    }

    func testProviderHintIsStaticAndSecureFieldScrollsHorizontally() throws {
        let components = try sourceFile("SetupComponents.swift")
        let hint = components.components(separatedBy: "struct ProviderListAffordance")[1]
            .components(separatedBy: "func providerSelectionIndex")[0]
        XCTAssertFalse(hint.contains("chevron"))
        XCTAssertFalse(hint.contains("Button("))
        XCTAssertTrue(hint.contains("accessibilityElement(children: .combine)"))
        XCTAssertTrue(hint.contains("allowsHitTesting(false)"))
        XCTAssertEqual(SetupCopy.moreProvidersHint, "下方还有供应商，可滚动查看")

        let configure = components.components(separatedBy: "private func configure()")[1]
            .components(separatedBy: "override func viewDidMoveToWindow")[0]
        XCTAssertTrue(configure.contains("cell?.wraps = false"))
        XCTAssertTrue(configure.contains("cell?.isScrollable = true"))
        XCTAssertTrue(configure.contains("alignment = .left"))
    }

    private func sourceFile(_ name: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/LauncherMacOS")
        return try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
    }
}
