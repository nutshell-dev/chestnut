import Foundation
import XCTest

/// Static packaging contracts only. These tests deliberately do not invoke pnpm,
/// swiftc, package-app.sh, a GUI process, or the installed-app smoke script.
final class LauncherPackageLayoutTests: XCTestCase {
    private var macOSDirectory: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func readScript(_ name: String) throws -> String {
        let url = macOSDirectory.appendingPathComponent("Scripts/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testInfoPlistDeclaresExecutableApplicationBundle() throws {
        let url = macOSDirectory.appendingPathComponent("Info.plist")
        let data = try Data(contentsOf: url)
        let value = try PropertyListSerialization.propertyList(from: data, format: nil)
        let plist = try XCTUnwrap(value as? [String: Any])

        XCTAssertEqual(plist["CFBundleExecutable"] as? String, "chestnut-launcher")
        XCTAssertEqual(plist["CFBundlePackageType"] as? String, "APPL")
        XCTAssertEqual(plist["CFBundleInfoDictionaryVersion"] as? String, "6.0")
        XCTAssertEqual(plist["CFBundleIdentifier"] as? String, "dev.nutshell.chestnut.launcher")
        XCTAssertEqual(plist["LSUIElement"] as? Bool, true)
    }

    func testPackageScriptOwnsCompleteReproducibleLayout() throws {
        let script = try readScript("package-app.sh")

        for token in [
            "set -euo pipefail", "--config.strict-dep-builds=false build", "dist/cli.js", "--output", "--node", "--launcher",
            "Contents/MacOS", "chestnut-launcher", "chestnut-cli/dist", "Resources/node/bin",
            "libLauncherCore.dylib", "@executable_path/core", "node_modules", "install", "--prod", "--offline", "build-metadata.json",
            "sourceRevision", "generatedAt", "architecture", "plutil -lint",
        ] {
            XCTAssertTrue(script.contains(token), "package script is missing contract token: \(token)")
        }
        XCTAssertFalse(script.contains("jq "))
    }

    func testSmokeScriptIsolatesStateAndChecksRelocatedBundle() throws {
        let script = try readScript("smoke-installed-app.sh")

        for token in [
            "set -euo pipefail", "mktemp", "env -i", "CHESTNUT", "Application Support/Chestnut",
            "launcher status --json", "chestnut.launcher.v2", "snapshot", "empty-path", "node_modules",
            "moved app with spaces", ".chestnut", "PENDING", "start/send/stream",
        ] {
            XCTAssertTrue(script.contains(token), "smoke script is missing contract token: \(token)")
        }
    }
}
