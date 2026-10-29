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
    private(set) var uiSemantics: LauncherUiSemantics?

    private let setupClient: any SetupClient
    private let startNonInteractive: (String?) async throws -> Void
    private let makeStore: () -> ChatStore
    private var providerCatalog: [SetupProvider] = []
    private var languageSample: String?
    private var requiresLanguageSample = false

    init(setupClient: any SetupClient,
         startNonInteractive: @escaping (String?) async throws -> Void,
         makeStore: @escaping () -> ChatStore) {
        self.setupClient = setupClient
        self.startNonInteractive = startNonInteractive
        self.makeStore = makeStore
    }

    func load() async {
        do {
            let presentation = try await setupClient.presentation()
            if let ui = presentation.ui { uiSemantics = ui }
            let setup = presentation.state
            if setup == .committed {
                if requiresLanguageSample { state = .initializing(.committed) } else { showChat() }
            } else { show(setup) }
        } catch { state = .failed(Self.failure(error)) }
    }

    func select(provider: SetupProvider) async -> SetupState? {
        do {
            let presentation = try await setupClient.selectProviderPresentation(provider.id)
            show(presentation)
            return presentation.state
        } catch { state = .failed(Self.failure(error)); return nil }
    }

    func submit(_ input: SetupInput) async {
        state = .initializing(.probing(provider: input.providerId, model: input.model))
        do {
            let presentation = try await setupClient.submitPresentation(input)
            let setup = presentation.state
            if let ui = presentation.ui { uiSemantics = ui }
            guard setup == .committed else { show(setup); return }
            // Probe/commit 成功后先取得语言样本，再启动 Motion onboarding。
            requiresLanguageSample = true
            state = .initializing(.committed)
        } catch { state = .failed(Self.failure(error)) }
    }

    func retry() async {
        do { show(try await setupClient.retryPresentation()) }
        catch { state = .failed(Self.failure(error)) }
    }

    func cancel() async {
        do { show(try await setupClient.cancelPresentation()) }
        catch { state = .failed(Self.failure(error)) }
    }

    func submitLanguage(_ sample: String?) async {
        languageSample = sample
        requiresLanguageSample = false
        await continueStart()
    }

    func continueStart() async {
        state = .starting
        do { try await startNonInteractive(languageSample); showChat() }
        catch {
            state = .failed(SetupFailure(errorType: "start", message: "配置已保存，启动失败"))
        }
    }

    private func show(_ presentation: SetupPresentation) {
        if let ui = presentation.ui { uiSemantics = ui }
        show(presentation.state)
    }

    private func show(_ setup: SetupState) {
        if case let .needsProvider(catalog) = setup { providerCatalog = catalog }
        state = .initializing(setup)
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
    case language

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
            self = .language
        }
    }

    var panelHeight: CGFloat {
        switch self {
        case .provider: return SetupVisual.providerPanelHeight
        case .credentials: return SetupVisual.credentialsPanelHeight
        case .repair: return SetupVisual.repairPanelHeight
        case .probing, .starting: return SetupVisual.statusPanelHeight
        case .language: return SetupVisual.credentialsPanelHeight
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
            apiKey: provider.auth == "local" || apiKey.isEmpty ? nil : SetupPaste.normalize(apiKey),
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
                SetupView(controller: controller, setup: setup, semantics: controller.uiSemantics,
                          onWindowHeightChange: onWindowHeightChange)
            case .starting:
                SetupView(controller: controller, screen: .starting, semantics: controller.uiSemantics,
                          onWindowHeightChange: onWindowHeightChange)
            case let .chat(store):
                ChatView(store: store, semantics: controller.uiSemantics, onWindowHeightChange: onWindowHeightChange)
            case let .failed(error):
                SetupView(
                    controller: controller,
                    screen: .repair(provider: nil, model: nil, failure: error),
                    semantics: controller.uiSemantics,
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
    let semantics: LauncherUiSemantics?
    let onWindowHeightChange: (CGFloat) -> Void

    @State private var selectedProviderId = ""
    @State private var draft = SetupDraft()
    @State private var languageSample = ""
    @State private var submissionGate = SetupSubmissionGate()
    @FocusState private var focusedField: SetupField?

    init(
        controller: LauncherRootController,
        screen: SetupScreen,
        semantics: LauncherUiSemantics? = nil,
        onWindowHeightChange: @escaping (CGFloat) -> Void
    ) {
        self.controller = controller
        self.screen = screen
        self.semantics = semantics
        self.onWindowHeightChange = onWindowHeightChange
    }

    init(
        controller: LauncherRootController,
        setup: SetupState,
        semantics: LauncherUiSemantics? = nil,
        onWindowHeightChange: @escaping (CGFloat) -> Void
    ) {
        self.init(controller: controller, screen: SetupScreen(setup), semantics: semantics,
                  onWindowHeightChange: onWindowHeightChange)
    }

    private var copy: SetupPresentationCopy { SetupPresentationCopy(semantics: semantics) }

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
            statusScreen(id: "setup.probing", busy: true)
        case let .repair(provider, savedModel, failure):
            repairScreen(provider: provider, savedModel: savedModel, failure: failure)
        case .starting:
            statusScreen(id: "setup.starting", busy: true)
        case .language:
            languageScreen()
        }
    }

    private func providerScreen(_ catalog: [SetupProvider]) -> some View {
        let screenCopy = copy.screen("setup.provider")
        let cancelCopy = copy.action("credentials.cancel")
        let submitCopy = copy.action("provider.submit")
        return SetupScaffold(
            step: screenCopy.step,
            title: screenCopy.title,
            subtitle: screenCopy.subtitle,
            height: screen.panelHeight,
            secondaryTitle: cancelCopy.label,
            cancel: { cancel() },
            identifier: screenCopy.id,
            secondaryIdentifier: cancelCopy.id,
            secondaryHint: cancelCopy.hint
        ) {
            VStack(spacing: 8) {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 8) {
                            ForEach(catalog, id: \.id) { provider in
                                ProviderRow(provider: provider, selected: selectedProviderId == provider.id) {
                                    selectedProviderId = provider.id
                                }
                                .disabled(submissionGate.isSubmitting)
                                .id(provider.id)
                            }
                        }
                        .padding(2)
                    }
                    .frame(height: SetupVisual.providerListHeight)
                    ProviderKeyboardNavigation(
                        catalog: catalog,
                        selectedProviderId: $selectedProviderId,
                        scrollTo: { id in proxy.scrollTo(id, anchor: .center) }
                    )
                }
                ProviderListAffordance(count: catalog.count, semantics: semantics)
            }
        } actions: {
            SetupPrimaryAction(
                title: submitCopy.label,
                disabled: selectedProviderId.isEmpty,
                busy: submissionGate.isSubmitting,
                action: {
                    selectProvider(from: catalog)
                },
                identifier: submitCopy.id,
                hint: submitCopy.hint,
                disabledReason: submitCopy.disabledReason
            )
        }
    }

    private func credentialsScreen(
        _ provider: SetupProvider,
        modelDefault: String?,
        savedModel: String?
    ) -> some View {
        let screenCopy = copy.screen("setup.credentials")
        let apiKeyCopy = copy.field("credentials.apiKey")
        let modelCopy = copy.field("credentials.model")
        let baseURLCopy = copy.field("credentials.baseUrl")
        let backCopy = copy.action("credentials.back")
        let submitCopy = copy.action("credentials.submit")
        return SetupScaffold(
            step: screenCopy.step,
            title: screenCopy.title,
            subtitle: copy.credentialsSubtitle(for: provider),
            height: screen.panelHeight,
            secondaryTitle: backCopy.label,
            cancel: { backToProvider() },
            identifier: screenCopy.id,
            secondaryIdentifier: backCopy.id,
            secondaryHint: backCopy.hint
        ) {
            VStack(spacing: 12) {
                if provider.auth != "local" {
                    SetupFieldRow(
                        label: apiKeyCopy.label,
                        placeholder: apiKeyCopy.placeholder ?? apiKeyCopy.label,
                        secure: apiKeyCopy.secure ?? true,
                        field: .apiKey,
                        text: $draft.apiKey,
                        focused: $focusedField,
                        onSubmit: { submit(provider) },
                        hint: apiKeyCopy.hint,
                        identifier: apiKeyCopy.id
                    )
                }
                SetupFieldRow(
                    label: modelCopy.label,
                    placeholder: semantics == nil
                        ? provider.defaultModel ?? modelCopy.placeholder ?? modelCopy.label
                        : modelCopy.placeholder ?? provider.defaultModel ?? modelCopy.label,
                    secure: modelCopy.secure ?? false,
                    field: .model,
                    text: Binding(get: { draft.model }, set: { draft.model = $0 }),
                    focused: $focusedField,
                    onSubmit: { submit(provider) },
                    hint: copy.defaultModelHint(modelDefault ?? provider.defaultModel),
                    identifier: modelCopy.id
                )
                if provider.auth == "advanced" {
                    SetupFieldRow(
                        label: baseURLCopy.label,
                        placeholder: baseURLCopy.placeholder ?? baseURLCopy.label,
                        secure: baseURLCopy.secure ?? false,
                        field: .baseURL,
                        text: $draft.baseURL,
                        focused: $focusedField,
                        onSubmit: { submit(provider) },
                        hint: baseURLCopy.hint,
                        identifier: baseURLCopy.id
                    )
                }
            }
            .disabled(submissionGate.isSubmitting)
        } actions: {
            SetupPrimaryAction(
                title: submitCopy.label,
                disabled: !draft.canSubmit(provider: provider),
                busy: submissionGate.isSubmitting,
                action: { submit(provider) },
                identifier: submitCopy.id,
                hint: submitCopy.hint,
                disabledReason: submitCopy.disabledReason
            )
        }
    }

    private func languageScreen() -> some View {
        let screenCopy = copy.screen("setup.language")
        let fieldCopy = copy.field("setup.language")
        let submitCopy = copy.action("language.submit")
        return SetupScaffold(
            step: screenCopy.step,
            title: screenCopy.title,
            subtitle: screenCopy.subtitle,
            height: screen.panelHeight,
            identifier: screenCopy.id
        ) {
            SetupFieldRow(
                label: fieldCopy.label,
                placeholder: fieldCopy.placeholder ?? fieldCopy.label,
                secure: fieldCopy.secure ?? false,
                field: .language,
                text: $languageSample,
                focused: $focusedField,
                onSubmit: submitLanguage,
                hint: fieldCopy.hint,
                identifier: fieldCopy.id
            )
            .disabled(submissionGate.isSubmitting)
        } actions: {
            SetupPrimaryAction(
                title: submitCopy.label,
                disabled: false,
                busy: submissionGate.isSubmitting,
                action: submitLanguage,
                identifier: submitCopy.id,
                hint: submitCopy.hint,
                disabledReason: submitCopy.disabledReason
            )
        }
    }

    private func repairScreen(provider: SetupProvider?, savedModel: String?, failure: SetupFailure) -> some View {
        let isStartFailure = failure.errorType == "start"
        let screenCopy = copy.screen(isStartFailure ? "setup.start_failure" : "setup.repair")
        let errorCopy = copy.failure(failure)
        let cancelCopy = copy.action("repair.cancel")
        let editCopy = copy.action("repair.edit")
        let primaryCopy = copy.action(isStartFailure ? "start.retry" : provider == nil ? "status.recheck" : "repair.retry")
        return SetupScaffold(
            title: screenCopy.title,
            subtitle: screenCopy.subtitle,
            height: screen.panelHeight,
            secondaryTitle: cancelCopy.label,
            cancel: isStartFailure ? nil : { cancel() },
            identifier: screenCopy.id,
            secondaryIdentifier: cancelCopy.id,
            secondaryHint: cancelCopy.hint
        ) {
            Label(errorCopy.label, systemImage: "exclamationmark.circle")
                .foregroundStyle(.orange)
                .font(.system(size: 14))
                .fixedSize(horizontal: false, vertical: true)
                .nativeAccessibility(NativeAccessibilityProjection(
                    identifier: errorCopy.id,
                    label: errorCopy.label,
                    hint: errorCopy.hint,
                    role: .staticText
                ))
        } actions: {
            if let provider, !isStartFailure {
                Button(editCopy.label) {
                    controller.stateForEditing(provider: provider, model: savedModel ?? draft.model)
                }
                .buttonStyle(.bordered)
                .nativeAccessibility(NativeAccessibilityProjection(
                    identifier: editCopy.id,
                    label: editCopy.label,
                    hint: editCopy.hint,
                    role: .button
                ))
            }
            SetupPrimaryAction(
                title: primaryCopy.label,
                disabled: false,
                busy: submissionGate.isSubmitting,
                action: {
                    guard submissionGate.begin() else { return }
                    if isStartFailure {
                        perform { await controller.continueStart() }
                    } else if provider == nil {
                        perform { await controller.load() }
                    } else {
                        perform { await controller.retry() }
                    }
                },
                identifier: primaryCopy.id,
                hint: primaryCopy.hint,
                disabledReason: primaryCopy.disabledReason
            )
        }
    }

    private func statusScreen(id: String, busy: Bool) -> some View {
        let screenCopy = copy.screen(id)
        let stateCopy = copy.state(busy ? "setup.waiting" : "setup.ready")
        return SetupScaffold(title: screenCopy.title, subtitle: screenCopy.subtitle,
                             height: screen.panelHeight, identifier: screenCopy.id) {
            HStack(spacing: 10) {
                if busy { ProgressView().controlSize(.small) }
                Text(stateCopy.label)
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
            }
            .nativeAccessibility(NativeAccessibilityProjection(
                identifier: stateCopy.id,
                label: stateCopy.label,
                hint: stateCopy.hint,
                role: .staticText
            ))
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
        case .language:
            languageSample = ""
            focusedField = .language
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

    private func submitLanguage() {
        guard submissionGate.begin() else { return }
        let sample = languageSample.trimmingCharacters(in: .whitespacesAndNewlines)
        focusedField = nil
        perform { await controller.submitLanguage(sample.isEmpty ? nil : sample) }
    }

    private func backToProvider() {
        guard !submissionGate.isSubmitting else { return }
        focusedField = nil
        draft.apiKey = ""
        _ = controller.stateForProviderSelection()
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
    @discardableResult
    func stateForProviderSelection() -> Bool {
        guard !providerCatalog.isEmpty else { return false }
        show(.needsProvider(catalog: providerCatalog))
        return true
    }

    func stateForEditing(provider: SetupProvider, model: String?) {
        state = .initializing(.needsCredentials(provider: provider, modelDefault: provider.defaultModel, model: model))
    }
}
