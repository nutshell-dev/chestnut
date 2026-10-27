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
            state = .failed(SetupFailure(errorType: "start", message: "配置已保存，启动失败，可重试：\(error.localizedDescription)"))
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

struct LauncherRootView: View {
    @ObservedObject var controller: LauncherRootController
    let onWindowHeightChange: (CGFloat) -> Void

    var body: some View {
        Group {
            switch controller.state {
            case let .initializing(setup):
                SetupView(controller: controller, setup: setup)
            case .starting:
                ProgressView("正在启动 Motion…").frame(width: 560, height: 180)
            case let .chat(store):
                ChatView(store: store, onWindowHeightChange: onWindowHeightChange)
            case let .failed(error):
                VStack(spacing: 16) {
                    Text(error.message).multilineTextAlignment(.center)
                    HStack {
                        if error.errorType == "start" {
                            Button("重试启动") { Task { await controller.continueStart() } }
                        }
                        Button("重新检查") { Task { await controller.load() } }
                    }
                }.padding(32).frame(width: 560)
            }
        }
        .task { await controller.load() }
    }
}

struct SetupView: View {
    @ObservedObject var controller: LauncherRootController
    let setup: SetupState
    @State private var selectedProviderId = ""
    @State private var model = ""
    @State private var apiKey = ""
    @State private var baseUrl = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("首次初始化").font(.title2).bold()
            switch setup {
            case let .needsProvider(catalog):
                Text("选择服务供应商")
                Picker("供应商", selection: $selectedProviderId) {
                    Text("请选择").tag("")
                    ForEach(catalog, id: \.id) { provider in Text(provider.label).tag(provider.id) }
                }.labelsHidden()
                Button("继续") {
                    guard let provider = catalog.first(where: { $0.id == selectedProviderId }) else { return }
                    Task { _ = await controller.select(provider: provider) }
                }.disabled(selectedProviderId.isEmpty)
            case let .needsCredentials(provider, modelDefault, savedModel):
                Text(provider.description)
                SecureField("API Key", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .opacity(provider.auth == "local" ? 0.5 : 1)
                    .disabled(provider.auth == "local")
                TextField("模型", text: $model).textFieldStyle(.roundedBorder)
                if provider.auth == "advanced" {
                    TextField("Base URL", text: $baseUrl).textFieldStyle(.roundedBorder)
                }
                Button("验证并继续") {
                    let input = SetupInput(providerId: provider.id, model: model,
                                           apiKey: apiKey.isEmpty ? nil : apiKey,
                                           baseUrl: baseUrl.isEmpty ? nil : baseUrl)
                    apiKey = ""
                    Task { await controller.submit(input) }
                }.disabled(model.isEmpty || (provider.auth != "local" && apiKey.isEmpty))
                .onAppear { if model.isEmpty { model = savedModel ?? modelDefault ?? "" } }
            case let .probing(provider, model):
                ProgressView("正在验证 \(provider) / \(model)…")
            case let .repair(provider, savedModel, failure, _):
                Text("验证失败（\(failure.errorType)）").foregroundStyle(.red)
                Text(failure.message)
                HStack {
                    Button("重试") { Task { await controller.retry() } }
                    Button("修改后重新提交") {
                        if let provider {
                            controller.stateForEditing(provider: provider, model: savedModel ?? model)
                        }
                    }
                    Button("取消") { Task { await controller.cancel() } }
                }
            case .committed:
                Text("配置已保存")
            }
            if case .needsProvider = setup {
                Button("取消") { Task { await controller.cancel() } }.foregroundStyle(.secondary)
            } else if case .needsCredentials = setup {
                Button("取消") { Task { await controller.cancel() } }.foregroundStyle(.secondary)
            }
        }
        .padding(32)
        .frame(width: 560, alignment: .leading)
    }
}

extension LauncherRootController {
    func stateForEditing(provider: SetupProvider, model: String?) {
        state = .initializing(.needsCredentials(provider: provider, modelDefault: provider.defaultModel, model: model))
    }
}
