import XCTest
@testable import LauncherMacOS

final class LauncherClientFactoryTests: XCTestCase {
    func testFactoryUsesOnlyLauncherJSONCommands() {
        let environment = ["CHESTNUT_CLI_JS": "/tmp/cli.js", "CHESTNUT_CLAW_NAME": "ignored"]
        for command in ["status", "setup", "start", "send", "stream"] {
            let argv = LauncherClientFactory.launcherArgv(environment: environment, command: command)
            XCTAssertEqual(argv, ["node", "/tmp/cli.js", "launcher", command, "--json"])
            XCTAssertFalse(argv?.contains("claw") == true)
        }
    }

    func testStreamRestoresCurrentTurn() {
        let argv = LauncherClientFactory.launcherArgv(
            environment: ["CHESTNUT_CLI_JS": "/tmp/cli.js"],
            command: "stream",
            options: ["--from-current-turn"]
        )
        XCTAssertEqual(argv?.suffix(2), ["--json", "--from-current-turn"])
    }
}
