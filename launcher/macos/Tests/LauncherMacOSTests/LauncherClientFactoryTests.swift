import Foundation
import XCTest
@testable import LauncherMacOS

final class LauncherClientFactoryTests: XCTestCase {
    private let resources = LauncherRuntimeResources(
        nodeURL: URL(fileURLWithPath: "/tmp/Chestnut.app/Contents/Resources/node/bin/node"),
        cliURL: URL(fileURLWithPath: "/tmp/Chestnut.app/Contents/Resources/chestnut-cli/dist/cli.js"),
        rootURL: URL(fileURLWithPath: "/tmp/home/Library/Application Support/Chestnut")
    )

    func testFactoryUsesOnlyLauncherJSONCommands() {
        for command in ["status", "setup", "start", "send", "stream"] {
            let argv = LauncherClientFactory.launcherArgv(resources: resources, command: command)
            XCTAssertEqual(argv, [resources.cliURL.path, "launcher", command, "--json"])
            XCTAssertFalse(argv.contains("node"), "Node 是明确 executable，不应进入 argv 或依赖 PATH")
            XCTAssertFalse(argv.contains("claw"))
        }
    }

    func testStreamRestoresCurrentTurn() {
        let argv = LauncherClientFactory.launcherArgv(
            resources: resources,
            command: "stream",
            options: ["--from-current-turn"]
        )
        XCTAssertEqual(argv.suffix(2), ["--json", "--from-current-turn"])
    }
}
