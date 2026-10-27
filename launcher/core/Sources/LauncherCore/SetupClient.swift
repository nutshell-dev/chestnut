import Foundation

public protocol SetupClient: Sendable {
    func status() async throws -> SetupState
    func selectProvider(_ providerId: String) async throws -> SetupState
    func submit(_ input: SetupInput) async throws -> SetupState
    func retry() async throws -> SetupState
    func cancel() async throws -> SetupState
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
        guard let statusArgv else { return try await request("status") }
        let output = try await process.run(statusArgv, stdin: "{\"command\":\"status\"}\n")
        guard output.terminationSignal == nil, output.exitCode == 0, output.stdoutLines.count == 1,
              let line = output.stdoutLines.first else {
            throw ChatError.transport(detail: "launcher status failed: \(output.stderr)")
        }
        let envelope = try LauncherWireDecoder().decode(line: line)
        guard envelope.kind == .snapshot, let setup = envelope.payload["setup"] else {
            throw ChatError.protocolMismatch(detail: "launcher status requires a snapshot with setup state")
        }
        return try SetupState.decode(setup)
    }

    public func selectProvider(_ providerId: String) async throws -> SetupState {
        try await request("select_provider", payload: ["providerId": providerId])
    }

    public func submit(_ input: SetupInput) async throws -> SetupState {
        var payload: [String: Any] = ["providerId": input.providerId, "model": input.model]
        if let apiKey = input.apiKey, !apiKey.isEmpty { payload["apiKey"] = apiKey }
        if let baseUrl = input.baseUrl { payload["baseUrl"] = baseUrl }
        return try await request("submit", payload: payload)
    }

    public func retry() async throws -> SetupState { try await request("retry") }
    public func cancel() async throws -> SetupState { try await request("cancel") }

    private func request(_ action: String, payload: [String: Any] = [:]) async throws -> SetupState {
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
        return try SetupState.decode(response.payload)
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
