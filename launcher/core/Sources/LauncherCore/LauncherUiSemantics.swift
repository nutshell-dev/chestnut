import Foundation

public struct UiScreen: Equatable, Sendable {
    public let id: String
    public let title: String
    public let step: String?
    public let subtitle: String?
    public let status: String?
    public let hint: String?

    public init(id: String, title: String, step: String? = nil, subtitle: String? = nil,
                status: String? = nil, hint: String? = nil) {
        self.id = id
        self.title = title
        self.step = step
        self.subtitle = subtitle
        self.status = status
        self.hint = hint
    }
}

public struct UiField: Equatable, Sendable {
    public let id: String
    public let label: String
    public let hint: String?
    public let placeholder: String?
    public let secure: Bool?
    public let required: Bool?

    public init(id: String, label: String, hint: String? = nil, placeholder: String? = nil,
                secure: Bool? = nil, required: Bool? = nil) {
        self.id = id
        self.label = label
        self.hint = hint
        self.placeholder = placeholder
        self.secure = secure
        self.required = required
    }
}

public struct UiAction: Equatable, Sendable {
    public let id: String
    public let label: String
    public let hint: String?
    public let enabledWhen: [String]?
    public let disabledReason: String?

    public init(id: String, label: String, hint: String? = nil, enabledWhen: [String]? = nil,
                disabledReason: String? = nil) {
        self.id = id
        self.label = label
        self.hint = hint
        self.enabledWhen = enabledWhen
        self.disabledReason = disabledReason
    }
}

public struct UiState: Equatable, Sendable {
    public enum Tone: String, Equatable, Sendable {
        case neutral
        case error
    }

    public let id: String
    public let label: String
    public let hint: String?
    public let busy: Bool?
    public let tone: Tone?

    public init(id: String, label: String, hint: String? = nil, busy: Bool? = nil, tone: Tone? = nil) {
        self.id = id
        self.label = label
        self.hint = hint
        self.busy = busy
        self.tone = tone
    }
}

public struct UiError: Equatable, Sendable {
    public let id: String
    public let label: String
    public let hint: String?

    public init(id: String, label: String, hint: String? = nil) {
        self.id = id
        self.label = label
        self.hint = hint
    }
}

/// Business copy and constraints supplied by the CLI. No platform accessibility roles or secrets.
public struct LauncherUiSemantics: Equatable, Sendable {
    public static let supportedProtocol = "chestnut.ui.v1"

    public let protocolVersion: String
    public let locale: String
    public let screens: [String: UiScreen]
    public let fields: [String: UiField]
    public let actions: [String: UiAction]
    public let states: [String: UiState]
    public let errors: [String: UiError]

    public init(protocolVersion: String = LauncherUiSemantics.supportedProtocol, locale: String,
                screens: [String: UiScreen], fields: [String: UiField], actions: [String: UiAction],
                states: [String: UiState], errors: [String: UiError]) {
        self.protocolVersion = protocolVersion
        self.locale = locale
        self.screens = screens
        self.fields = fields
        self.actions = actions
        self.states = states
        self.errors = errors
    }

    /// Decodes the optional `ui` member of a setup payload. Absence is legacy-compatible;
    /// a present but malformed value fails closed instead of silently dropping CLI copy.
    public static func decode(_ value: JSONValue?) throws -> LauncherUiSemantics? {
        guard let value else { return nil }
        do {
            let protocolVersion = try requiredString(value, "protocol")
            guard protocolVersion == supportedProtocol else {
                throw ChatError.protocolMismatch(
                    detail: "unsupported UI semantics protocol '\(protocolVersion)' (expected \(supportedProtocol))"
                )
            }
            return LauncherUiSemantics(
                protocolVersion: protocolVersion,
                locale: try requiredString(value, "locale"),
                screens: try decodeRecord(value, "screens", decodeScreen),
                fields: try decodeRecord(value, "fields", decodeField),
                actions: try decodeRecord(value, "actions", decodeAction),
                states: try decodeRecord(value, "states", decodeState),
                errors: try decodeRecord(value, "errors", decodeError)
            )
        } catch let error as ChatError {
            throw error
        } catch {
            throw ChatError.protocolMismatch(detail: "malformed UI semantics: \(error.localizedDescription)")
        }
    }

    private static func decodeRecord<T>(_ value: JSONValue, _ key: String,
                                        _ decode: (JSONValue) throws -> T) throws -> [String: T] {
        guard case let .object(record)? = value[key] else {
            throw ChatError.protocolMismatch(detail: "UI semantics requires object '\(key)'")
        }
        var result: [String: T] = [:]
        for (id, item) in record { result[id] = try decode(item) }
        return result
    }

    private static func decodeScreen(_ value: JSONValue) throws -> UiScreen {
        UiScreen(id: try requiredString(value, "id"), title: try requiredString(value, "title"),
                 step: try optionalString(value, "step"), subtitle: try optionalString(value, "subtitle"),
                 status: try optionalString(value, "status"), hint: try optionalString(value, "hint"))
    }

    private static func decodeField(_ value: JSONValue) throws -> UiField {
        UiField(id: try requiredString(value, "id"), label: try requiredString(value, "label"),
                hint: try optionalString(value, "hint"), placeholder: try optionalString(value, "placeholder"),
                secure: try optionalBool(value, "secure"), required: try optionalBool(value, "required"))
    }

    private static func decodeAction(_ value: JSONValue) throws -> UiAction {
        UiAction(id: try requiredString(value, "id"), label: try requiredString(value, "label"),
                 hint: try optionalString(value, "hint"), enabledWhen: try optionalStrings(value, "enabledWhen"),
                 disabledReason: try optionalString(value, "disabledReason"))
    }

    private static func decodeState(_ value: JSONValue) throws -> UiState {
        let tone: UiState.Tone?
        if let raw = try optionalString(value, "tone") {
            guard let decoded = UiState.Tone(rawValue: raw) else {
                throw ChatError.protocolMismatch(detail: "unknown UI state tone '\(raw)'")
            }
            tone = decoded
        } else {
            tone = nil
        }
        return UiState(id: try requiredString(value, "id"), label: try requiredString(value, "label"),
                       hint: try optionalString(value, "hint"), busy: try optionalBool(value, "busy"), tone: tone)
    }

    private static func decodeError(_ value: JSONValue) throws -> UiError {
        UiError(id: try requiredString(value, "id"), label: try requiredString(value, "label"),
                hint: try optionalString(value, "hint"))
    }

    private static func requiredString(_ value: JSONValue, _ key: String) throws -> String {
        guard let string = value[key]?.stringValue else {
            throw ChatError.protocolMismatch(detail: "UI semantics requires string '\(key)'")
        }
        return string
    }

    private static func optionalString(_ value: JSONValue, _ key: String) throws -> String? {
        guard let item = value[key] else { return nil }
        guard let string = item.stringValue else {
            throw ChatError.protocolMismatch(detail: "UI semantics requires string '\(key)'")
        }
        return string
    }

    private static func optionalBool(_ value: JSONValue, _ key: String) throws -> Bool? {
        guard let item = value[key] else { return nil }
        guard case let .bool(bool) = item else {
            throw ChatError.protocolMismatch(detail: "UI semantics requires boolean '\(key)'")
        }
        return bool
    }

    private static func optionalStrings(_ value: JSONValue, _ key: String) throws -> [String]? {
        guard let item = value[key] else { return nil }
        guard case let .array(items) = item else {
            throw ChatError.protocolMismatch(detail: "UI semantics requires string array '\(key)'")
        }
        return try items.map { item in
            guard let string = item.stringValue else {
                throw ChatError.protocolMismatch(detail: "UI semantics requires string array '\(key)'")
            }
            return string
        }
    }
}
