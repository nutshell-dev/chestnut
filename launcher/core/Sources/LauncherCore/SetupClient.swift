import Foundation

public struct SetupPresentation: Equatable, Sendable {
    public let state: SetupState
    public let ui: LauncherUiSemantics?

    public init(state: SetupState, ui: LauncherUiSemantics? = nil) {
        self.state = state
        self.ui = ui
    }
}

public protocol SetupClient: Sendable {
    func status() async throws -> SetupState
    func selectProvider(_ providerId: String) async throws -> SetupState
    func submit(_ input: SetupInput) async throws -> SetupState
    func retry() async throws -> SetupState
    func cancel() async throws -> SetupState
    func presentation() async throws -> SetupPresentation
    func selectProviderPresentation(_ providerId: String) async throws -> SetupPresentation
    func submitPresentation(_ input: SetupInput) async throws -> SetupPresentation
    func retryPresentation() async throws -> SetupPresentation
    func cancelPresentation() async throws -> SetupPresentation
}

public extension SetupClient {
    /// Keeps existing mocks and older clients source-compatible. Real CLI clients override this
    /// so state and semantics are decoded from the same process response.
    func presentation() async throws -> SetupPresentation {
        SetupPresentation(state: try await status(), ui: nil)
    }

    func selectProviderPresentation(_ providerId: String) async throws -> SetupPresentation {
        SetupPresentation(state: try await selectProvider(providerId), ui: nil)
    }

    func submitPresentation(_ input: SetupInput) async throws -> SetupPresentation {
        SetupPresentation(state: try await submit(input), ui: nil)
    }

    func retryPresentation() async throws -> SetupPresentation {
        SetupPresentation(state: try await retry(), ui: nil)
    }

    func cancelPresentation() async throws -> SetupPresentation {
        SetupPresentation(state: try await cancel(), ui: nil)
    }
}

/// Setup requests carry secrets on stdin, never in argv or logs.
public protocol SetupChestnutProcess: ChestnutProcess {
    func run(_ argv: [String], stdin: String?) async throws -> ProcessOutput
}

public struct ChestnutSetupClient: SetupClient {
    private let process: any SetupChestnutProcess
    private let argvPrefix: [String]
    private let statusArgv: [String]?

    public init(process: any SetupChestnutProcess, argvPrefix: [String], statusArgv: [String]? = nil) {
        self.process = process
        self.argvPrefix = argvPrefix
        self.statusArgv = statusArgv
    }

    public func status() async throws -> SetupState {
        try await presentation().state
    }

    public func presentation() async throws -> SetupPresentation {
        guard let statusArgv else { return try await requestPresentation("status") }
        let output = try await process.run(statusArgv, stdin: "{\"command\":\"status\"}\n")
        guard output.terminationSignal == nil, output.exitCode == 0, output.stdoutLines.count == 1,
              let line = output.stdoutLines.first else {
            throw ChatError.transport(detail: "launcher status failed: \(output.stderr)")
        }
        let envelope = try LauncherWireDecoder().decode(line: line)
        guard envelope.kind == .snapshot, let setup = envelope.payload["setup"] else {
            throw ChatError.protocolMismatch(detail: "launcher status requires a snapshot with setup state")
        }
        return try Self.decodePresentation(setup)
    }

    public func selectProvider(_ providerId: String) async throws -> SetupState {
        try await selectProviderPresentation(providerId).state
    }

    public func selectProviderPresentation(_ providerId: String) async throws -> SetupPresentation {
        try await requestPresentation("select_provider", payload: ["providerId": providerId])
    }

    public func submit(_ input: SetupInput) async throws -> SetupState {
        try await submitPresentation(input).state
    }

    public func submitPresentation(_ input: SetupInput) async throws -> SetupPresentation {
        var payload: [String: Any] = ["providerId": input.providerId, "model": input.model]
        if let apiKey = input.apiKey, !apiKey.isEmpty { payload["apiKey"] = apiKey }
        if let baseUrl = input.baseUrl { payload["baseUrl"] = baseUrl }
        return try await requestPresentation("submit", payload: payload)
    }

    public func retry() async throws -> SetupState { try await retryPresentation().state }
    public func retryPresentation() async throws -> SetupPresentation { try await requestPresentation("retry") }
    public func cancel() async throws -> SetupState { try await cancelPresentation().state }
    public func cancelPresentation() async throws -> SetupPresentation { try await requestPresentation("cancel") }

    private func requestPresentation(_ action: String, payload: [String: Any] = [:]) async throws -> SetupPresentation {
        let requestId = UUID().uuidString
        var object: [String: Any] = [
            "protocolVersion": "chestnut.launcher.setup.v1",
            "requestId": requestId,
            "action": action,
        ]
        if !payload.isEmpty { object["payload"] = payload }
        let data = try JSONSerialization.data(withJSONObject: object)
        let line = String(decoding: data, as: UTF8.self) + "\n"
        let output = try await process.run(argvPrefix, stdin: line)
        guard output.terminationSignal == nil, output.exitCode == 0 else {
            throw ChatError.transport(detail: "setup process failed: \(output.stderr)")
        }
        let responses = output.stdoutLines.filter { !$0.isEmpty }.compactMap(Self.decodeResponse)
        guard responses.count == 1, let response = responses.first, response.requestId == requestId else {
            throw ChatError.protocolMismatch(detail: "setup requires exactly one matching JSONL response")
        }
        if response.kind == "error" {
            throw ChatError.rejected(detail: response.payload["message"]?.stringValue ?? "setup failed")
        }
        return try Self.decodePresentation(response.payload)
    }

    private static func decodePresentation(_ payload: JSONValue) throws -> SetupPresentation {
        SetupPresentation(state: try SetupState.decode(payload), ui: try LauncherUiSemantics.decode(payload["ui"]))
    }

    private static func decodeResponse(_ line: String) -> SetupResponse? {
        struct Wire: Decodable {
            let protocolVersion: String
            let requestId: String
            let kind: String
            let payload: JSONValue
        }
        guard let data = line.data(using: .utf8),
              let wire = try? JSONDecoder().decode(Wire.self, from: data),
              wire.protocolVersion == "chestnut.launcher.setup.v1" else { return nil }
        return SetupResponse(requestId: wire.requestId, kind: wire.kind, payload: wire.payload)
    }
}
