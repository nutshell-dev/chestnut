import XCTest
import LauncherCore
@testable import LauncherMacOS

@MainActor
final class LauncherStartupTests: XCTestCase {
    final class FakeSetupClient: SetupClient, @unchecked Sendable {
        var next: SetupState
        var cancelCalls = 0
        var statusCalls = 0
        init(_ next: SetupState) { self.next = next }
        func status() async throws -> SetupState { statusCalls += 1; return next }
        func selectProvider(_ providerId: String) async throws -> SetupState { next }
        func submit(_ input: SetupInput) async throws -> SetupState { next }
        func retry() async throws -> SetupState { next }
        func cancel() async throws -> SetupState { cancelCalls += 1; return next }
    }

    func testReadyCreatesExactlyOneChatStoreWithoutStart() async {
        var creations = 0
        var starts = 0
        let controller = LauncherRootController(
            setupClient: FakeSetupClient(.committed),
            startNonInteractive: { _ in starts += 1 },
            makeStore: {
                creations += 1
                return ChatStore(send: UnconfiguredSendClient(), stream: UnconfiguredStreamClient())
            }
        )
        await controller.load()
        await controller.load()
        guard case .chat = controller.state else { return XCTFail("expected chat") }
        XCTAssertEqual(creations, 1)
        XCTAssertEqual(starts, 0)
    }

    func testCommittedSetupWaitsForLanguageSampleBeforeCreatingChat() async {
        var creations = 0
        var samples: [String?] = []
        let controller = LauncherRootController(
            setupClient: FakeSetupClient(.committed),
            startNonInteractive: { sample in samples.append(sample) },
            makeStore: {
                creations += 1
                return ChatStore(send: UnconfiguredSendClient(), stream: UnconfiguredStreamClient())
            }
        )
        await controller.submit(SetupInput(providerId: "openai", model: "gpt-test", apiKey: "secret"))
        guard case .initializing(.committed) = controller.state else {
            return XCTFail("expected language step after committed setup")
        }
        XCTAssertEqual(samples.count, 0)
        XCTAssertEqual(creations, 0)
        await controller.load() // SwiftUI task 重入也不得跳过语言步骤
        guard case .initializing(.committed) = controller.state else {
            return XCTFail("committed reload must preserve the language step")
        }
        XCTAssertEqual(samples.count, 0)
        XCTAssertEqual(creations, 0)
        await controller.submitLanguage("你好")
        guard case .chat = controller.state else { return XCTFail("expected chat") }
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples[0] ?? nil, "你好")
        XCTAssertEqual(creations, 1)
    }

    func testBackToProviderPreservesSetupSessionWithoutCancel() async {
        let provider = SetupProvider(id: "openai", label: "OpenAI", description: "OpenAI API", auth: "api_key", defaultModel: "gpt-test")
        let client = FakeSetupClient(.needsProvider(catalog: [provider]))
        let controller = LauncherRootController(
            setupClient: client,
            startNonInteractive: { _ in },
            makeStore: { ChatStore(send: UnconfiguredSendClient(), stream: UnconfiguredStreamClient()) }
        )
        await controller.load()
        client.next = .needsCredentials(provider: provider, modelDefault: provider.defaultModel, model: nil)
        _ = await controller.select(provider: provider)
        XCTAssertTrue(controller.stateForProviderSelection())
        guard case let .initializing(.needsProvider(catalog)) = controller.state else {
            return XCTFail("expected provider screen without changing CLI session")
        }
        XCTAssertEqual(catalog, [provider])
        XCTAssertEqual(client.cancelCalls, 0)
    }

    func testReopeningDoesNotReloadCommittedLanguageStep() async {
        let client = FakeSetupClient(.needsProvider(catalog: []))
        let controller = LauncherRootController(
            setupClient: client,
            startNonInteractive: { _ in },
            makeStore: { ChatStore(send: UnconfiguredSendClient(), stream: UnconfiguredStreamClient()) }
        )
        await controller.loadIfNeeded()
        XCTAssertEqual(client.statusCalls, 1)

        client.next = .committed
        await controller.submit(SetupInput(providerId: "openai", model: "gpt-test"))
        guard case .initializing(.committed) = controller.state else {
            return XCTFail("expected language step")
        }

        await controller.loadIfNeeded()
        XCTAssertEqual(client.statusCalls, 1, "重开不得重新查询 status 或覆盖当前 setup 状态")
        guard case .initializing(.committed) = controller.state else {
            return XCTFail("reopen must preserve the language step")
        }
    }

    func testStartFailureIsDistinctFromCommittedConfiguration() async {
        let controller = LauncherRootController(
            setupClient: FakeSetupClient(.committed),
            startNonInteractive: { _ in throw ChatError.rejected(detail: "daemon failed") },
            makeStore: { ChatStore(send: UnconfiguredSendClient(), stream: UnconfiguredStreamClient()) }
        )
        await controller.submit(SetupInput(providerId: "openai", model: "gpt-test"))
        await controller.continueStart()
        guard case let .failed(error) = controller.state else { return XCTFail("expected start failure") }
        XCTAssertEqual(error.errorType, "start")
        XCTAssertTrue(error.message.contains("配置已保存"))
    }
}
