import Foundation

/// launcher v2 的 daemon 事实状态。状态只由 CLI 产生，Swift 不自行探测或推断。
public enum LauncherDaemonState: String, Equatable, Sendable {
    case unknown
    case starting
    case running
    case stopped
    case error
}

/// CLI shared bootstrap 的 onboarding 事实；Swift 只解码，不创建或恢复 contract。
public enum LauncherOnboardingState: String, Equatable, Sendable {
    case complete
    case created
    case resumed
    case pending
}

/// send_ack 的真实投递阶段；persisted 不代表 daemon 已开始处理。
public enum LauncherDeliveryState: String, Equatable, Sendable {
    case persisted
    case queued
    case processing
    case rejected
}

/// chestnut.launcher.v2 envelope。v2 没有 sessionId，未知 kind 保留原始值。
public struct LauncherWireEnvelope: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case snapshot
        case daemon
        case activity
        case message
        case sendAck
        case error
        case terminal
        case unknown(String)
    }

    public static let supportedProtocol = "chestnut.launcher.v2"

    public let protocolVersion: String
    public let sequence: Int
    public let kind: Kind
    public let payload: JSONValue

    public init(protocolVersion: String, sequence: Int, kind: Kind, payload: JSONValue) {
        self.protocolVersion = protocolVersion
        self.sequence = sequence
        self.kind = kind
        self.payload = payload
    }
}

extension LauncherWireEnvelope {
    /// start ready envelope 携带的 onboarding 结果；其他 daemon 事件可以为空。
    public var onboarding: LauncherOnboardingState? {
        guard kind == .daemon, let raw = payload["onboarding"]?.stringValue else { return nil }
        return LauncherOnboardingState(rawValue: raw)
    }
}

extension LauncherWireEnvelope: Decodable {
    private enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case sequence, kind, payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let protocolVersion = try container.decode(String.self, forKey: .protocolVersion)
        let sequence = try container.decode(Int.self, forKey: .sequence)
        let rawKind = try container.decode(String.self, forKey: .kind)
        let payload = try container.decode(JSONValue.self, forKey: .payload)
        let kind: Kind
        switch rawKind {
        case "snapshot": kind = .snapshot
        case "daemon": kind = .daemon
        case "activity": kind = .activity
        case "message": kind = .message
        case "send_ack": kind = .sendAck
        case "error": kind = .error
        case "terminal": kind = .terminal
        default: kind = .unknown(rawKind)
        }
        self.init(protocolVersion: protocolVersion, sequence: sequence, kind: kind, payload: payload)
    }
}

/// v2 JSONL decoder：空行、非 JSON、缺字段和版本不符均 fail closed。
public struct LauncherWireDecoder: Sendable {
    public init() {}

    public func decode(line: String) throws -> LauncherWireEnvelope {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            throw ChatError.protocolMismatch(detail: "non-protocol line on protocol stdout")
        }
        let envelope: LauncherWireEnvelope
        do {
            envelope = try JSONDecoder().decode(LauncherWireEnvelope.self, from: data)
        } catch {
            throw ChatError.protocolMismatch(detail: "malformed protocol line: \(trimmed.prefix(120))")
        }
        guard envelope.protocolVersion == LauncherWireEnvelope.supportedProtocol else {
            throw ChatError.protocolMismatch(
                detail: "unsupported protocol version '\(envelope.protocolVersion)' (expected \(LauncherWireEnvelope.supportedProtocol))"
            )
        }
        return envelope
    }
}
