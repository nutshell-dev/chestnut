import LauncherCore
import SwiftUI

enum LauncherRootState {
    case initializing(SetupState)
    case starting
    case chat(ChatStore)
    case failed(SetupFailure)
}

@MainActor
final class LauncherRootController: ObservableObject {
    @Published private(set) var state: LauncherRootState = .initializing(.needsProvider(catalog: []))

    private let setupClient: any SetupClient
    private let startNonInteractive: () async throws -> Void
    private let makeStore: () -> ChatStore

    init(setupClient: any SetupClient,
         startNonInteractive: @escaping () async throws -> Void,
         makeStore: @escaping () -> ChatStore) {
        self.setupClient = setupClient
        self.startNonInteractive = startNonInteractive
        self.makeStore = makeStore
    }

    func load() async {
        do {
            let setup = try await setupClient.status()
            if setup == .committed { showChat() } else { state = .initializing(setup) }
        } catch { state = .failed(Self.failure(error)) }
    }

    func select(provider: SetupProvider) async -> SetupState? {
        do {
            let setup = try await setupClient.selectProvider(provider.id)
            state = .initializing(setup)
            return setup
        } catch { state = .failed(Self.failure(error)); return nil }
    }

    func submit(_ input: SetupInput) async {
        state = .initializing(.probing(provider: input.providerId, model: input.model))
        do {
            let setup = try await setupClient.submit(input)
            guard setup == .committed else { state = .initializing(setup); return }
            await continueStart()
        } catch { state = .failed(Self.failure(error)) }
    }

    func retry() async {
        do { state = .initializing(try await setupClient.retry()) }
        catch { state = .failed(Self.failure(error)) }
    }

    func cancel() async {
        do { state = .initializing(try await setupClient.cancel()) }
        catch { state = .failed(Self.failure(error)) }
    }

    func continueStart() async {
        state = .starting
        do { try await startNonInteractive(); showChat() }
        catch {
            state = .failed(SetupFailure(errorType: "start", message: "配置已保存，启动失败"))
        }
    }

    private func showChat() {
        if case .chat = state { return }
        state = .chat(makeStore())
    }

    private static func failure(_ error: Error) -> SetupFailure {
        SetupFailure(errorType: "transport", message: error.localizedDescription)
    }
}

enum SetupScreen: Equatable {
    case provider(catalog: [SetupProvider])
    case credentials(provider: SetupProvider, modelDefault: String?, savedModel: String?)
    case probing(provider: String, model: String)
    case repair(provider: SetupProvider?, model: String?, failure: SetupFailure)
    case starting
    case committed

    init(_ setup: SetupState) {
        switch setup {
        case let .needsProvider(catalog):
            self = .provider(catalog: catalog)
        case let .needsCredentials(provider, modelDefault, savedModel):
            self = .credentials(provider: provider, modelDefault: modelDefault, savedModel: savedModel)
        case let .probing(provider, model):
            self = .probing(provider: provider, model: model)
        case let .repair(provider, model, failure, _):
            self = .repair(provider: provider, model: model, failure: failure)
        case .committed:
            self = .committed
        }
    }

    var panelHeight: CGFloat {
        switch self {
        case .provider: return SetupVisual.providerPanelHeight
        case .credentials: return SetupVisual.credentialsPanelHeight
        case .repair: return SetupVisual.repairPanelHeight
        case .probing, .starting, .committed: return SetupVisual.statusPanelHeight
        }
    }
}

struct SetupDraft {
    var model = ""
    var apiKey = ""
    var baseURL = ""

    mutating func configure(provider: SetupProvider, modelDefault: String?, savedModel: String?) {
        model = savedModel ?? modelDefault ?? provider.defaultModel ?? ""
        apiKey = ""
        baseURL = ""
    }

    func canSubmit(provider: SetupProvider) -> Bool {
        !model.isEmpty && (provider.auth == "local" || !apiKey.isEmpty)
    }

    mutating func consumeInput(provider: SetupProvider) -> SetupInput {
        let input = SetupInput(
            providerId: provider.id,
            model: model,
            apiKey: provider.auth == "local" || apiKey.isEmpty ? nil : apiKey,
            baseUrl: provider.auth == "advanced" && !baseURL.isEmpty ? baseURL : nil
        )
        apiKey = ""
        return input
    }
}

struct SetupSubmissionGate {
    private(set) var isSubmitting = false

    mutating func begin() -> Bool {
        guard !isSubmitting else { return false }
        isSubmitting = true
        return true
    }

    mutating func end() { isSubmitting = false }
}

struct LauncherRootView: View {
    @ObservedObject var controller: LauncherRootController
    let onWindowHeightChange: (CGFloat) -> Void

    var body: some View {
        Group {
            switch controller.state {
            case let .initializing(setup):
                SetupView(controller: controller, setup: setup, onWindowHeightChange: onWindowHeightChange)
            case .starting:
                SetupView(controller: controller, screen: .starting, onWindowHeightChange: onWindowHeightChange)
            case let .chat(store):
                ChatView(store: store, onWindowHeightChange: onWindowHeightChange)
            case let .failed(error):
                SetupView(
                    controller: controller,
                    screen: .repair(provider: nil, model: nil, failure: error),
                    onWindowHeightChange: onWindowHeightChange
                )
            }
        }
        .task { await controller.load() }
    }
}

struct SetupView: View {
    @ObservedObject var controller: LauncherRootController
    let screen: SetupScreen
    let onWindowHeightChange: (CGFloat) -> Void

    @State private var selectedProviderId = ""
    @State private var draft = SetupDraft()
    @State private var submissionGate = SetupSubmissionGate()
    @FocusState private var focusedField: SetupField?

    init(
        controller: LauncherRootController,
        screen: SetupScreen,
        onWindowHeightChange: @escaping (CGFloat) -> Void
    ) {
        self.controller = controller
        self.screen = screen
        self.onWindowHeightChange = onWindowHeightChange
    }

    init(
        controller: LauncherRootController,
        setup: SetupState,
        onWindowHeightChange: @escaping (CGFloat) -> Void
    ) {
        self.init(controller: controller, screen: SetupScreen(setup), onWindowHeightChange: onWindowHeightChange)
    }

    var body: some View {
        content
            .onAppear(perform: prepareForScreen)
            .onChange(of: screen) { _ in
                prepareForScreen()
                onWindowHeightChange(screen.panelHeight)
            }
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case let .provider(catalog):
            providerScreen(catalog)
        case let .credentials(provider, modelDefault, savedModel):
            credentialsScreen(provider, modelDefault: modelDefault, savedModel: savedModel)
        case .probing:
            statusScreen(
                title: SetupCopy.probingTitle,
                subtitle: SetupCopy.probingSubtitle,
                busy: true
            )
        case let .repair(provider, savedModel, failure):
            repairScreen(provider: provider, savedModel: savedModel, failure: failure)
        case .starting:
            statusScreen(title: SetupCopy.startingTitle, subtitle: nil, busy: true)
        case .committed:
            statusScreen(title: SetupCopy.committedTitle, subtitle: nil, busy: false)
        }
    }

    private func providerScreen(_ catalog: [SetupProvider]) -> some View {
        SetupScaffold(
            step: SetupCopy.providerStep,
            title: SetupCopy.providerTitle,
            subtitle: SetupCopy.providerSubtitle,
            height: screen.panelHeight,
            cancel: { cancel() }
        ) {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(catalog, id: \.id) { provider in
                        ProviderRow(provider: provider, selected: selectedProviderId == provider.id) {
                            selectedProviderId = provider.id
                        }
                        .disabled(submissionGate.isSubmitting)
                    }
                }
                .padding(2)
            }
            .frame(height: SetupVisual.providerListHeight)
        } actions: {
            SetupPrimaryAction(
                title: SetupCopy.continueAction,
                disabled: selectedProviderId.isEmpty,
                busy: submissionGate.isSubmitting
            ) {
                selectProvider(from: catalog)
            }
        }
    }

    private func credentialsScreen(
        _ provider: SetupProvider,
        modelDefault: String?,
        savedModel: String?
    ) -> some View {
        SetupScaffold(
            step: SetupCopy.credentialsStep,
            title: SetupCopy.credentialsTitle,
            subtitle: SetupCopy.credentialsSubtitle(for: provider),
            height: screen.panelHeight,
            cancel: { cancel() }
        ) {
            VStack(spacing: 12) {
                SetupFieldRow(
                    label: SetupCopy.modelLabel,
                    placeholder: provider.defaultModel ?? SetupCopy.modelLabel,
                    secure: false,
                    field: .model,
                    text: Binding(get: { draft.model }, set: { draft.model = $0 }),
                    focused: $focusedField,
                    onSubmit: { submit(provider) }
                )
                if provider.auth != "local" {
                    SetupFieldRow(
                        label: SetupCopy.apiKeyLabel,
                        placeholder: SetupCopy.apiKeyLabel,
                        secure: true,
                        field: .apiKey,
                        text: $draft.apiKey,
                        focused: $focusedField,
                        onSubmit: { submit(provider) }
                    )
                }
                if provider.auth == "advanced" {
                    SetupFieldRow(
                        label: SetupCopy.baseURLLabel,
                        placeholder: SetupCopy.baseURLLabel,
                        secure: false,
                        field: .baseURL,
                        text: $draft.baseURL,
                        focused: $focusedField,
                        onSubmit: { submit(provider) }
                    )
                }
            }
            .disabled(submissionGate.isSubmitting)
        } actions: {
            SetupPrimaryAction(
                title: SetupCopy.submitAction,
                disabled: !draft.canSubmit(provider: provider),
                busy: submissionGate.isSubmitting
            ) {
                submit(provider)
            }
        }
    }

    private func repairScreen(provider: SetupProvider?, savedModel: String?, failure: SetupFailure) -> some View {
        let isStartFailure = failure.errorType == "start"
        return SetupScaffold(
            title: isStartFailure ? SetupCopy.startFailureTitle : SetupCopy.repairTitle,
            subtitle: nil,
            height: screen.panelHeight,
            cancel: isStartFailure ? nil : { cancel() }
        ) {
            Label(SetupCopy.failure(failure), systemImage: "exclamationmark.circle")
                .foregroundStyle(.orange)
                .font(.system(size: 14))
                .fixedSize(horizontal: false, vertical: true)
        } actions: {
            if let provider, !isStartFailure {
                Button(SetupCopy.editAction) {
                    controller.stateForEditing(provider: provider, model: savedModel ?? draft.model)
                }
                .buttonStyle(.bordered)
            }
            SetupPrimaryAction(
                title: isStartFailure ? SetupCopy.retryStartAction : provider == nil ? SetupCopy.recheckAction : SetupCopy.retryAction,
                disabled: false,
                busy: submissionGate.isSubmitting
            ) {
                guard submissionGate.begin() else { return }
                if isStartFailure {
                    perform { await controller.continueStart() }
                } else if provider == nil {
                    perform { await controller.load() }
                } else {
                    perform { await controller.retry() }
                }
            }
        }
    }

    private func statusScreen(title: String, subtitle: String?, busy: Bool) -> some View {
        SetupScaffold(title: title, subtitle: subtitle, height: screen.panelHeight) {
            HStack(spacing: 10) {
                if busy { ProgressView().controlSize(.small) }
                Text(busy ? SetupCopy.pleaseWait : SetupCopy.readySubtitle)
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
            }
        } actions: {
            EmptyView()
        }
    }

    private func prepareForScreen() {
        submissionGate.end()
        focusedField = nil
        switch screen {
        case .provider:
            selectedProviderId = ""
        case let .credentials(provider, modelDefault, savedModel):
            draft.configure(provider: provider, modelDefault: modelDefault, savedModel: savedModel)
            focusedField = provider.auth == "local" ? .model : .apiKey
        default:
            break
        }
        onWindowHeightChange(screen.panelHeight)
    }

    private func selectProvider(from catalog: [SetupProvider]) {
        guard !submissionGate.isSubmitting,
              let provider = catalog.first(where: { $0.id == selectedProviderId }),
              submissionGate.begin() else { return }
        perform { _ = await controller.select(provider: provider) }
    }

    private func submit(_ provider: SetupProvider) {
        guard draft.canSubmit(provider: provider), submissionGate.begin() else { return }
        let input = draft.consumeInput(provider: provider)
        focusedField = nil
        perform { await controller.submit(input) }
    }

    private func cancel() {
        guard submissionGate.begin() else { return }
        perform { await controller.cancel() }
    }

    private func perform(_ operation: @escaping () async -> Void) {
        Task {
            defer { submissionGate.end() }
            await operation()
        }
    }
}

extension LauncherRootController {
    func stateForEditing(provider: SetupProvider, model: String?) {
        state = .initializing(.needsCredentials(provider: provider, modelDefault: provider.defaultModel, model: model))
    }
}
