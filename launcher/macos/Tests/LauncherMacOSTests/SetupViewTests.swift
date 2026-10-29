import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

final class SetupViewTests: XCTestCase {
    private let provider = SetupProvider(
        id: "openai",
        label: "OpenAI",
        description: "OpenAI API with a deliberately long description for layout coverage",
        auth: "advanced",
        defaultModel: "gpt-test"
    )

    func testProviderProjectionPreservesCatalogOrderAndUniqueSelectionSource() {
        let catalog = (0..<13).map { index in
            SetupProvider(id: "provider-\(index)", label: "Provider \(index)", description: "Description", auth: "api_key")
        }
        let screen = SetupScreen(.needsProvider(catalog: catalog))
        guard case let .provider(projected) = screen else { return XCTFail("expected provider screen") }
        XCTAssertEqual(projected.map(\.id), catalog.map(\.id))
        XCTAssertEqual(screen.panelHeight, SetupVisual.providerPanelHeight)
    }

    func testProviderOverflowIsVisibleAndKeyboardReachesEveryBoundary() throws {
        let count = 12
        XCTAssertEqual(SetupCopy.providerCount(count), "共 12 个服务供应商")
        XCTAssertEqual(SetupCopy.moreProvidersHint, "下方还有供应商，可滚动查看")
        XCTAssertGreaterThan(count, SetupVisual.visibleProviderCount)
        XCTAssertEqual(providerSelectionIndex(current: nil, offset: 1, count: count), 0)
        XCTAssertEqual(providerSelectionIndex(current: nil, offset: -1, count: count), count - 1)
        XCTAssertEqual(providerSelectionIndex(current: 0, offset: -1, count: count), 0)
        XCTAssertEqual(providerSelectionIndex(current: count - 1, offset: 1, count: count), count - 1)
        XCTAssertEqual(providerSelectionIndex(current: 5, offset: SetupVisual.visibleProviderCount, count: count), count - 1)

        let source = try setupSource()
        XCTAssertTrue(source.view.contains("ScrollViewReader"))
        XCTAssertTrue(source.view.contains("ProviderListAffordance"))
        XCTAssertTrue(source.components.contains(".keyboardShortcut(.pageDown)"))
        XCTAssertTrue(source.components.contains(".keyboardShortcut(.upArrow)"))
        XCTAssertTrue(source.components.contains(".keyboardShortcut(.end)"))
    }

    func testCredentialsUseSavedModelThenCliDefault() {
        var draft = SetupDraft()
        draft.configure(provider: provider, modelDefault: "cli-default", savedModel: "saved-model")
        XCTAssertEqual(draft.model, "saved-model")
        draft.configure(provider: provider, modelDefault: "cli-default", savedModel: nil)
        XCTAssertEqual(draft.model, "cli-default")
    }

    func testConsumingInputClearsSecretAndKeepsNonSecretDraft() {
        var draft = SetupDraft()
        draft.configure(provider: provider, modelDefault: nil, savedModel: nil)
        draft.apiKey = "sk-secret"
        draft.baseURL = "https://example.test"
        let input = draft.consumeInput(provider: provider)
        XCTAssertEqual(input.apiKey, "sk-secret")
        XCTAssertEqual(input.baseUrl, "https://example.test")
        XCTAssertEqual(input.model, "gpt-test")
        XCTAssertTrue(draft.apiKey.isEmpty)
        XCTAssertEqual(draft.baseURL, "https://example.test")
    }

    func testLocalProviderDoesNotRequireOrSubmitApiKey() {
        let local = SetupProvider(id: "local", label: "Local", description: "Local", auth: "local", defaultModel: "local-model")
        var draft = SetupDraft()
        draft.configure(provider: local, modelDefault: nil, savedModel: nil)
        XCTAssertTrue(draft.canSubmit(provider: local))
        draft.apiKey = "must-not-leak"
        XCTAssertNil(draft.consumeInput(provider: local).apiKey)
        XCTAssertTrue(draft.apiKey.isEmpty)
    }

    func testSubmissionGateRejectsConcurrentReturn() {
        var gate = SetupSubmissionGate()
        XCTAssertTrue(gate.begin())
        XCTAssertTrue(gate.isSubmitting)
        XCTAssertFalse(gate.begin())
        gate.end()
        XCTAssertTrue(gate.begin())
    }

    func testFailureCopyIsActionableWithoutInternalDetailOrSecret() {
        let secret = "sk-secret"
        for errorType in ["auth", "network", "transport", "unknown"] {
            let copy = SetupCopy.failure(SetupFailure(errorType: errorType, message: "bad key \(secret)"))
            XCTAssertFalse(copy.contains(secret))
            XCTAssertFalse(copy.contains(errorType))
            XCTAssertFalse(copy.contains("bad key"))
        }
        XCTAssertTrue(SetupCopy.failure(SetupFailure(errorType: "start", message: "daemon raw detail")).contains("配置已保存"))
    }

    func testPhaseCopySeparatesConfigurationVerificationSaveAndStart() {
        XCTAssertEqual(SetupCopy.submitAction, "验证并保存配置")
        XCTAssertTrue(SetupCopy.probingTitle.contains("连接"))
        XCTAssertTrue(SetupCopy.readySubtitle.contains("配置已保存"))
        XCTAssertFalse(SetupCopy.probingSubtitle.contains("provider"))
        XCTAssertFalse(SetupCopy.probingSubtitle.contains("model"))
        XCTAssertFalse(SetupCopy.failure(SetupFailure(errorType: "network", message: "raw")).contains("API Key"))
        XCTAssertFalse(SetupCopy.failure(SetupFailure(errorType: "unknown", message: "raw")).contains("API Key"))
        XCTAssertTrue(SetupCopy.credentialsSubtitle(for: provider).contains("验证通过才会保存"))
        XCTAssertEqual(SetupCopy.defaultModelHint("gpt-test"), "默认模型：gpt-test，可直接使用")
        XCTAssertEqual(SetupCopy.backAction, "返回上一步")
        XCTAssertEqual(SetupCopy.cancelAction, "退出设置")
        XCTAssertEqual(SetupCopy.languageStep, "第 3 步，共 3 步")
        XCTAssertEqual(SetupCopy.languageTitle, "Select language / 选择语言")
        XCTAssertTrue(SetupCopy.languageSubtitle.contains("auto-detect"))
    }

    func testEverySetupStateHasAnExplicitHeight() {
        let screens: [SetupScreen] = [
            .provider(catalog: [provider]),
            .credentials(provider: provider, modelDefault: "gpt-test", savedModel: nil),
            .probing(provider: provider.id, model: "gpt-test"),
            .repair(provider: provider, model: "gpt-test", failure: SetupFailure(errorType: "auth", message: "raw")),
            .starting,
            .language,
        ]
        XCTAssertEqual(Set(screens.map(\.panelHeight)).count, 4)
        for screen in screens {
            XCTAssertGreaterThan(screen.panelHeight, 0)
            XCTAssertEqual(SetupVisual.panelWidth, 640)
            XCTAssertEqual(SetupVisual.contentWidth, 520)
        }
    }

    func testCommittedSetupProjectsToLanguageInputStep() {
        let screen = SetupScreen(.committed)
        guard case .language = screen else { return XCTFail("expected language input after probe commit") }
        XCTAssertEqual(screen.panelHeight, SetupVisual.credentialsPanelHeight)
    }

    func testOnboardingStructureUsesRowsSecureInputAndKeyboardPrimaryAction() throws {
        let source = try setupSource()
        XCTAssertTrue(source.components.contains("struct ProviderRow"))
        XCTAssertTrue(source.components.contains("struct SetupScaffold"))
        XCTAssertTrue(source.components.contains("PasteCapableSecureField"))
        XCTAssertTrue(source.components.contains("NSSecureTextField"))
        XCTAssertTrue(source.components.contains(".keyboardShortcut(.defaultAction)"))
        XCTAssertTrue(source.view.contains("@FocusState"))
        XCTAssertTrue(source.view.contains("submissionGate.begin()"))
        XCTAssertFalse(source.view.contains("Picker("))
        XCTAssertFalse(source.view.contains("Text(failure.message)"))
    }

    func testSecondaryNavigationUsesVisibleNativeButtonTarget() throws {
        let source = try setupSource()
        let scaffold = source.components.components(separatedBy: "struct SetupScaffold")[1]
        XCTAssertTrue(scaffold.contains("Button(secondaryTitle, action: cancel)"))
        XCTAssertTrue(scaffold.contains(".buttonStyle(.bordered)"))
        XCTAssertFalse(scaffold.contains("Button(secondaryTitle, action: cancel)\n                        .buttonStyle(.plain)"))
    }

    func testCredentialsOrderAndInputBridgeAvoidEditingFeedbackLoop() throws {
        let source = try setupSource()
        let credentials = source.view.components(separatedBy: "private func credentialsScreen")[1]
            .components(separatedBy: "private func repairScreen")[0]
        let apiKey = credentials.range(of: "label: apiKeyCopy.label")!.lowerBound
        let model = credentials.range(of: "label: modelCopy.label")!.lowerBound
        let baseURL = credentials.range(of: "label: baseURLCopy.label")!.lowerBound
        XCTAssertTrue(apiKey < model && model < baseURL)
        XCTAssertTrue(credentials.contains("hint: copy.defaultModelHint"))
        let update = source.components.components(separatedBy: "func updateNSView")[1]
            .components(separatedBy: "struct SetupFieldRow")[0]
        XCTAssertFalse(update.contains("makeFirstResponder"))
        XCTAssertTrue(update.contains("!context.coordinator.isEditing"))
        XCTAssertTrue(source.components.contains("viewDidMoveToWindow"))
        XCTAssertTrue(source.components.contains("remaining: Int = 40"))
        XCTAssertTrue(source.components.contains("final class Coordinator"))
    }

    func testSetupSourceDoesNotLogOrInterpolateApiKey() throws {
        let source = try setupSource()
        for file in [source.view, source.components, source.copy] {
            XCTAssertFalse(file.contains("NSLog"))
            XCTAssertFalse(file.contains("print("))
            XCTAssertFalse(file.contains("\\(draft.apiKey)"))
        }
    }

    private func setupSource() throws -> (view: String, components: String, copy: String) {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/LauncherMacOS")
        return try (
            String(contentsOf: root.appendingPathComponent("SetupView.swift"), encoding: .utf8),
            String(contentsOf: root.appendingPathComponent("SetupComponents.swift"), encoding: .utf8),
            String(contentsOf: root.appendingPathComponent("SetupCopy.swift"), encoding: .utf8)
        )
    }
}
