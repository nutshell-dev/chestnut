import Foundation
import XCTest
@testable import LauncherCore

final class SetupClientTests: XCTestCase {
    final class FakeProcess: SetupChestnutProcess, @unchecked Sendable {
        var argv: [String] = []
        var stdin: String?
        var actions: [String] = []
        var runCount = 0
        var response: (String, String) -> String = { requestId, _ in
            #"{"protocolVersion":"chestnut.launcher.setup.v1","requestId":"\#(requestId)","kind":"committed","payload":{"phase":"committed"}}"#
        }
        func run(_ argv: [String]) async throws -> ProcessOutput { try await run(argv, stdin: nil) }
        func run(_ argv: [String], stdin: String?) async throws -> ProcessOutput {
            runCount += 1
            self.argv = argv
            self.stdin = stdin
            let object = try JSONSerialization.jsonObject(with: Data((stdin ?? "").utf8)) as! [String: Any]
            if object["command"] != nil {
                return ProcessOutput(stdoutLines: [response("", "command")], stderr: "", exitCode: 0, terminationSignal: nil)
            }
            let requestId = object["requestId"] as! String
            let action = object["action"] as! String
            actions.append(action)
            return ProcessOutput(stdoutLines: [response(requestId, action)], stderr: "", exitCode: 0, terminationSignal: nil)
        }
        func stream(_ argv: [String]) -> AsyncThrowingStream<String, Error> { AsyncThrowingStream { $0.finish() } }
        func stop() async {}
    }

    func testDecodesCatalogAndRepairState() async throws {
        let process = FakeProcess()
        process.response = { requestId, action in
            if action == "status" {
                return #"{"protocolVersion":"chestnut.launcher.setup.v1","requestId":"\#(requestId)","kind":"state","payload":{"phase":"needs_provider","catalog":[{"id":"openai","label":"OpenAI","description":"OpenAI API","auth":"api_key","defaultModel":"gpt-test"}]}}"#
            }
            return #"{"protocolVersion":"chestnut.launcher.setup.v1","requestId":"\#(requestId)","kind":"state","payload":{"phase":"repair","failure":{"errorType":"auth","message":"bad key"},"actions":["retry","edit","cancel"]}}"#
        }
        let client = ChestnutSetupClient(process: process, argvPrefix: ["node", "cli", "launcher", "setup", "--json"])
        guard case let .needsProvider(catalog) = try await client.status() else { return XCTFail("expected catalog") }
        XCTAssertEqual(catalog.first?.id, "openai")
        guard case let .repair(_, _, failure, actions) = try await client.retry() else { return XCTFail("expected repair") }
        XCTAssertEqual(failure.errorType, "auth")
        XCTAssertEqual(actions, ["retry", "edit", "cancel"])
    }

    func testPresentationDecodesUiFromSameV1Response() async throws {
        let process = FakeProcess()
        process.response = { requestId, _ in
            #"{"protocolVersion":"chestnut.launcher.setup.v1","requestId":"\#(requestId)","kind":"state","payload":{"phase":"committed","ui":{"protocol":"chestnut.ui.v1","locale":"zh-CN","screens":{},"fields":{},"actions":{},"states":{},"errors":{}}}}"#
        }
        let client = ChestnutSetupClient(process: process, argvPrefix: ["launcher", "setup", "--json"])
        let presentation = try await client.presentation()
        XCTAssertEqual(presentation.state, .committed)
        XCTAssertEqual(presentation.ui?.locale, "zh-CN")
        XCTAssertEqual(process.runCount, 1)
    }

    func testLauncherStatusUsesV2SnapshotSetupState() async throws {
        let process = FakeProcess()
        process.response = { _, _ in
            #"{"protocol":"chestnut.launcher.v2","sequence":1,"kind":"snapshot","payload":{"setup":{"phase":"committed"}}}"#
        }
        let client = ChestnutSetupClient(
            process: process,
            argvPrefix: ["launcher", "setup", "--json"],
            statusArgv: ["launcher", "status", "--json"]
        )
        let presentation = try await client.presentation()
        XCTAssertEqual(presentation.state, .committed)
        XCTAssertNil(presentation.ui)
        XCTAssertEqual(process.argv, ["launcher", "status", "--json"])
        XCTAssertEqual(process.runCount, 1)
    }

    func testSecretUsesStdinNeverArgvAndCommittedDecodes() async throws {
        let process = FakeProcess()
        let client = ChestnutSetupClient(process: process, argvPrefix: ["node", "cli", "launcher", "setup", "--json"])
        let state = try await client.submit(SetupInput(providerId: "openai", model: "gpt-test", apiKey: "sk-secret"))
        XCTAssertEqual(state, .committed)
        XCTAssertFalse(process.argv.joined(separator: " ").contains("sk-secret"))
        XCTAssertTrue(process.stdin?.contains("sk-secret") == true)
    }

    func testRejectsMismatchedResponse() async {
        let process = FakeProcess()
        process.response = { _, _ in
            #"{"protocolVersion":"chestnut.launcher.setup.v1","requestId":"other","kind":"committed","payload":{"phase":"committed"}}"#
        }
        let client = ChestnutSetupClient(process: process, argvPrefix: [])
        do {
            _ = try await client.status()
            XCTFail("expected mismatch")
        } catch let error as ChatError {
            guard case .protocolMismatch = error else { return XCTFail("wrong error: \(error)") }
        } catch { XCTFail("wrong error") }
    }
}

extension SetupClientTests {
    func testRetryAndCancelUseExistingActionsWithoutSecretFields() async throws {
        let process = FakeProcess()
        process.response = { requestId, _ in
            #"{"protocolVersion":"chestnut.launcher.setup.v1","requestId":"\#(requestId)","kind":"state","payload":{"phase":"needs_provider","catalog":[]}}"#
        }
        let client = ChestnutSetupClient(process: process, argvPrefix: ["launcher", "setup", "--json"])
        _ = try await client.retry()
        _ = try await client.cancel()
        XCTAssertEqual(process.actions, ["retry", "cancel"])
        XCTAssertFalse(process.stdin?.contains("apiKey") == true)
        XCTAssertFalse(process.argv.joined(separator: " ").contains("secret"))
    }
}
