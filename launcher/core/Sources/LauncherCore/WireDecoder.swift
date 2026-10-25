import Foundation

/// 任意 JSON 值（envelope payload 的透明载体；decoder 不解释业务 payload）。
public enum JSONValue: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null
}

extension JSONValue: Decodable {
    public init(from decoder: Decoder) throws {
        if let container = try? decoder.singleValueContainer() {
            if container.decodeNil() { self = .null; return }
            if let value = try? container.decode(Bool.self) { self = .bool(value); return }
            if let value = try? container.decode(Double.self) { self = .number(value); return }
            if let value = try? container.decode(String.self) { self = .string(value); return }
            if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
            if let value = try? container.decode([String: JSONValue].self) { self = .object(value); return }
        }
        throw DecodingError.dataCorrupted(
            .init(codingPath: decoder.codingPath, debugDescription: "unsupported JSON value")
        )
    }
}

extension JSONValue {
    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        if case let .object(dict) = self { return dict[key] }
        return nil
    }
}

/// launcher 外部协议 envelope。当前 chestnut CLI 尚不产出该形状
/// （drift CLI-PROTOCOL-LAUNCHER-EXTERNAL-WIRE）；字段即 Step C 协议决策，
/// 未冻结字段以 chestnut code phase 为准。
public struct LauncherEnvelope: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case event
        /// Motion 活动行状态（phase 2001，v1 additive）。
        case activity
        case ack
        case error
        case terminal
        /// 未知 kind：保留元数据交 UI 降级展示，不作聊天事实。
        case unknown(String)
    }

    public static let supportedProtocolVersion = "chestnut.launcher.v1"

    public let protocolVersion: String
    public let sequence: Int
    public let sessionId: String
    public let kind: Kind
    public let payload: JSONValue

    public init(protocolVersion: String, sequence: Int, sessionId: String, kind: Kind, payload: JSONValue) {
        self.protocolVersion = protocolVersion
        self.sequence = sequence
        self.sessionId = sessionId
        self.kind = kind
        self.payload = payload
    }
}

extension LauncherEnvelope: Decodable {
    private enum CodingKeys: String, CodingKey {
        case protocolVersion, sequence, sessionId, kind, payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let protocolVersion = try container.decode(String.self, forKey: .protocolVersion)
        let sequence = try container.decode(Int.self, forKey: .sequence)
        let sessionId = try container.decode(String.self, forKey: .sessionId)
        let rawKind = try container.decode(String.self, forKey: .kind)
        let payload = try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
        let kind: Kind
        switch rawKind {
        case "event": kind = .event
        case "activity": kind = .activity
        case "ack": kind = .ack
        case "error": kind = .error
        case "terminal": kind = .terminal
        default: kind = .unknown(rawKind)
        }
        self.init(protocolVersion: protocolVersion, sequence: sequence, sessionId: sessionId, kind: kind, payload: payload)
    }
}

public enum SequenceDecision: Equatable, Sendable {
    case apply
    case duplicate
    case resync(requiredFrom: Int)
}

/// 事件序号判定：连号应用、回退/重复忽略、跳号触发 resync（从缺口下一号恢复）。
public func classifySequence(previous: Int, next: Int) -> SequenceDecision {
    if next == previous + 1 { return .apply }
    if next <= previous { return .duplicate }
    return .resync(requiredFrom: previous + 1)
}

/// JSONL 行 → envelope。严格策略：空行/非 JSON 行/缺字段/版本不符一律 protocolMismatch，
/// stdout 上的人类提示行不能当作事件（fail closed）。
public struct JsonlWireDecoder: Sendable {
    public init() {}

    public func decode(line: String) throws -> LauncherEnvelope {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            throw ChatError.protocolMismatch(detail: "non-protocol line on protocol stdout")
        }
        let envelope: LauncherEnvelope
        do {
            envelope = try JSONDecoder().decode(LauncherEnvelope.self, from: data)
        } catch {
            throw ChatError.protocolMismatch(detail: "malformed protocol line: \(trimmed.prefix(120))")
        }
        guard envelope.protocolVersion == LauncherEnvelope.supportedProtocolVersion else {
            throw ChatError.protocolMismatch(
                detail: "unsupported protocol version '\(envelope.protocolVersion)' (expected \(LauncherEnvelope.supportedProtocolVersion))"
            )
        }
        return envelope
    }
}

/// kind=activity 的展示载荷（phase 2001）：Motion 活动行状态，只含 phase/短标签/安全摘要。
public struct ActivityPayload: Equatable, Sendable {
    public enum Phase: String, Equatable, Sendable {
        case processing
        case responding
        case idle
        /// turn_error 保留的可读错误行（phase 2002）：不伪装 idle，下一次 send 才清除。
        case error
    }

    public let phase: Phase
    public let label: String?
    public let detail: String?
    public let traceId: String?

    /// 未知/缺失 phase 不解析（返回 nil，事件只推进 sequence 不产生活动变更）。
    public init?(payload: JSONValue) {
        guard let rawPhase = payload["phase"]?.stringValue,
              let phase = Phase(rawValue: rawPhase) else { return nil }
        self.phase = phase
        self.label = payload["label"]?.stringValue
        self.detail = payload["detail"]?.stringValue
        self.traceId = payload["traceId"]?.stringValue
    }
}

/// kind=event 且 payload 携带消息时的最小展示载荷（Step C 协议决策的 fixture 形状；
/// 业务 payload 事实来源仍归 chestnut Messaging/Viewport owner）。
public struct MotionMessagePayload: Equatable, Sendable {
    public let messageId: String
    public let role: Message.Role
    public let text: String

    public init?(payload: JSONValue) {
        guard let messageId = payload["messageId"]?.stringValue,
              let text = payload["text"]?.stringValue else { return nil }
        let rawRole = payload["role"]?.stringValue ?? Message.Role.motion.rawValue
        self.messageId = messageId
        self.role = Message.Role(rawValue: rawRole) ?? .motion
        self.text = text
    }
}
