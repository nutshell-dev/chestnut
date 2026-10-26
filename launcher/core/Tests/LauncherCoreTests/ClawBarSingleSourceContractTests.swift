import Foundation
import XCTest

/// phase 2004 契约：claw bar 错误行格式化只存在于 TS 协议输出
/// （`src/cli-protocol/claw-bar-display.ts`），Swift 零格式知识、只原样呈现。
///
/// phase 2003 Step F 曾在 Swift 复刻一条普通错误规则（ClawBarErrorLine），
/// 造成跨语言漂移面：TS 改符号/前缀时 Swift 不会自动失配。phase 2004 删除复刻，
/// 本测试把"Swift 源码不得持有 claw bar 格式词汇"锁为结构契约——
/// 任何在 Swift 重新引入格式化的尝试（符号字面量/格式化类型）都会在这里失败。
final class ClawBarSingleSourceContractTests: XCTestCase {

    /// claw bar 格式词汇：符号（✗/⟳/⏸）与已删除的 Swift 格式化入口。
    private static let bannedTokens = ["✗", "⟳", "⏸", "ClawBarErrorLine", "withClawBarDetail"]

    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // LauncherCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // core
            .deletingLastPathComponent() // launcher
            .deletingLastPathComponent() // repo root
    }

    private func swiftFiles(under dir: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else {
            return []
        }
        return enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    /// LauncherCore + LauncherMacOS 全部源码不得出现 claw bar 格式词汇
    /// （含注释——注释持有符号同样是漂移入口）。
    func testSwiftSourcesContainNoClawBarFormatVocabulary() throws {
        let launcher = repoRoot().appendingPathComponent("launcher")
        let sources = [
            launcher.appendingPathComponent("core/Sources"),
            launcher.appendingPathComponent("macos/Sources"),
        ]
        var offenders: [String] = []
        for dir in sources {
            for file in try swiftFiles(under: dir) {
                let text = try String(contentsOf: file, encoding: .utf8)
                for token in Self.bannedTokens where text.contains(token) {
                    offenders.append("\(file.lastPathComponent): \(token)")
                }
            }
        }
        XCTAssertTrue(
            offenders.isEmpty,
            "Swift 不得持有 claw bar 格式词汇（格式化单源在 TS cli-protocol/claw-bar-display）：\(offenders.joined(separator: ", "))"
        )
    }

    /// TS 格式化单源必须存在（契约的另一端锚点）。
    func testTsClawBarDisplaySingleSourceExists() throws {
        let tsSource = repoRoot().appendingPathComponent("src/cli-protocol/claw-bar-display.ts")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: tsSource.path),
            "claw bar 格式化 TS 单源缺失：\(tsSource.path)"
        )
    }
}
