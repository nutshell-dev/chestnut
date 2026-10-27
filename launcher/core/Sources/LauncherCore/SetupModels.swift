import Foundation

private extension JSONValue {
    var setupArrayValue: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }
}

public struct SetupProvider: Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String
    public let auth: String
    public let defaultModel: String?

    public init(id: String, label: String, description: String, auth: String, defaultModel: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
        self.auth = auth
        self.defaultModel = defaultModel
    }

    init?(_ value: JSONValue?) {
        guard let id = value?["id"]?.stringValue,
              let label = value?["label"]?.stringValue,
              let description = value?["description"]?.stringValue,
              let auth = value?["auth"]?.stringValue else { return nil }
        self.init(id: id, label: label, description: description, auth: auth,
                  defaultModel: value?["defaultModel"]?.stringValue)
    }
}

public struct SetupFailure: Equatable, Sendable {
    public let errorType: String
    public let message: String

    public init(errorType: String, message: String) {
        self.errorType = errorType
        self.message = message
    }
}

public enum SetupState: Equatable, Sendable {
    case needsProvider(catalog: [SetupProvider])
    case needsCredentials(provider: SetupProvider, modelDefault: String?, model: String?)
    case probing(provider: String, model: String)
    case repair(provider: SetupProvider?, model: String?, failure: SetupFailure, actions: [String])
    case committed
}

public struct SetupInput: Sendable {
    public let providerId: String
    public let model: String
    public let apiKey: String?
    public let baseUrl: String?

    public init(providerId: String, model: String, apiKey: String? = nil, baseUrl: String? = nil) {
        self.providerId = providerId
        self.model = model
        self.apiKey = apiKey
        self.baseUrl = baseUrl
    }
}

struct SetupResponse: Equatable {
    let requestId: String
    let kind: String
    let payload: JSONValue
}

extension SetupState {
    static func decode(_ payload: JSONValue) throws -> SetupState {
        let phase = payload["phase"]?.stringValue
        switch phase {
        case "needs_provider":
            guard case let .array(items)? = payload["catalog"] else {
                throw ChatError.protocolMismatch(detail: "setup catalog missing")
            }
            return .needsProvider(catalog: items.compactMap(SetupProvider.init))
        case "needs_credentials":
            guard let provider = SetupProvider(payload["provider"]) else {
                throw ChatError.protocolMismatch(detail: "setup provider missing")
            }
            return .needsCredentials(provider: provider,
                                     modelDefault: payload["modelDefault"]?.stringValue,
                                     model: payload["model"]?.stringValue)
        case "probing":
            return .probing(provider: payload["provider"]?.stringValue ?? "",
                            model: payload["model"]?.stringValue ?? "")
        case "repair":
            let failure = payload["failure"]
            let actions = (payload["actions"]?.setupArrayValue ?? []).compactMap(\.stringValue)
            return .repair(provider: SetupProvider(payload["provider"]),
                           model: payload["model"]?.stringValue,
                           failure: SetupFailure(errorType: failure?["errorType"]?.stringValue ?? "unknown",
                                                 message: failure?["message"]?.stringValue ?? "Setup failed"),
                           actions: actions)
        case "committed":
            return .committed
        default:
            throw ChatError.protocolMismatch(detail: "unknown setup phase: \(phase ?? "nil")")
        }
    }
}
