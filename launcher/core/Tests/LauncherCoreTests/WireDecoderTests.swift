import Foundation
import XCTest
@testable import LauncherCore

/// Step C：JSONL decoder 基础——envelope 解码、版本 fail closed、malformed/人类行拒绝。
/// ack/reply 区分、unknown event、sequence 语义见 Step D ChatProtocolTests。
final class WireDecoderTests: XCTestCase {
    private let decoder = JsonlWireDecoder()

    private func line(_ kind: String, sequence: Int = 1, version: String = "chestnut.launcher.v1", payload: String = "{}") -> String {
        """
        {"protocolVersion":"\(version)","sequence":\(sequence),"sessionId":"s1","kind":"\(kind)","payload":\(payload)}
        """
    }

    func testDecodesEventEnvelope() throws {
        let envelope = try decoder.decode(line: line("event", sequence: 7, payload: #"{"messageId":"m1","text":"hi"}"#))
        XCTAssertEqual(envelope.sequence, 7)
        XCTAssertEqual(envelope.sessionId, "s1")
        XCTAssertEqual(envelope.kind, .event)
        XCTAssertEqual(envelope.payload["messageId"]?.stringValue, "m1")
    }

    func testDecodesAckErrorTerminalKinds() throws {
        XCTAssertEqual(try decoder.decode(line: line("ack")).kind, .ack)
        XCTAssertEqual(try decoder.decode(line: line("error")).kind, .error)
        XCTAssertEqual(try decoder.decode(line: line("terminal")).kind, .terminal)
    }

    func testUnknownKindPreservedNotRejected() throws {
        let envelope = try decoder.decode(line: line("telemetry_v2"))
        XCTAssertEqual(envelope.kind, .unknown("telemetry_v2"))
    }

    func testVersionMismatchFailsClosed() {
        XCTAssertThrowsError(try decoder.decode(line: line("event", version: "chestnut.launcher.v2"))) { error in
            guard case let ChatError.protocolMismatch(detail) = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
            XCTAssertTrue(detail.contains("chestnut.launcher.v2"))
        }
    }

    func testMalformedJSONRejected() {
        XCTAssertThrowsError(try decoder.decode(line: #"{"protocolVersion":"#)) { error in
            guard case ChatError.protocolMismatch = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
        }
    }

    func testHumanLineRejected() {
        // stdout 人类提示行不能当作事件
        XCTAssertThrowsError(try decoder.decode(line: "Delivered to inbox")) { error in
            guard case ChatError.protocolMismatch = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
        }
    }

    func testBlankLineRejected() {
        XCTAssertThrowsError(try decoder.decode(line: "   ")) { error in
            guard case ChatError.protocolMismatch = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
        }
    }

    /// phase 1990：error envelope class 映射含 local（producer 本地启动失败）。
    func testWireErrorMapperLocalClass() throws {
        let envelope = try decoder.decode(line: line(
            "error",
            payload: #"{"class":"local","detail":"reader start failed"}"#
        ))
        guard case ChatError.local(let detail) = WireErrorMapper.map(envelope) else {
            return XCTFail("expected .local, got \(WireErrorMapper.map(envelope))")
        }
        XCTAssertEqual(detail, "reader start failed")
    }

    func testJSONValueNestedAccess() throws {
        let envelope = try decoder.decode(line: line(
            "event",
            payload: #"{"class":"daemon_stopped","detail":"not running","meta":{"attempt":2,"ok":true}}"#
        ))
        XCTAssertEqual(envelope.payload["class"]?.stringValue, "daemon_stopped")
        XCTAssertEqual(envelope.payload["meta"]?["attempt"], .number(2))
        XCTAssertEqual(envelope.payload["meta"]?["ok"], .bool(true))
        XCTAssertNil(envelope.payload["missing"])
    }

    // MARK: phase 2001 activity envelope

    /// activity kind 解码（v1 additive）。
    func testDecodesActivityEnvelope() throws {
        let envelope = try decoder.decode(line: line("activity", sequence: 3, payload: #"{"phase":"processing","label":"tool","detail":"search","traceId":"t1"}"#))
        XCTAssertEqual(envelope.kind, .activity)
        let activity = ActivityPayload(payload: envelope.payload)
        XCTAssertEqual(activity?.phase, .processing)
        XCTAssertEqual(activity?.label, "tool")
        XCTAssertEqual(activity?.detail, "search")
        XCTAssertEqual(activity?.traceId, "t1")
    }

    /// activity 可选字段缺省；未知 phase 返回 nil（只推进 sequence）。
    func testActivityPayloadDefaultsAndUnknownPhase() throws {
        let minimal = try decoder.decode(line: line("activity", payload: #"{"phase":"idle"}"#))
        let activity = ActivityPayload(payload: minimal.payload)
        XCTAssertEqual(activity?.phase, .idle)
        XCTAssertNil(activity?.label)
        XCTAssertNil(activity?.detail)

        let unknown = try decoder.decode(line: line("activity", payload: #"{"phase":"exploding"}"#))
        XCTAssertNil(ActivityPayload(payload: unknown.payload), "未知 activity phase 不解析")
    }

    /// error activity phase 解码（phase 2002：turn_error 保留可读错误行）。
    func testDecodesErrorActivityPhase() throws {
        let envelope = try decoder.decode(line: line("activity", sequence: 4, payload: #"{"phase":"error","label":"turn","detail":"LLM 网络失败","traceId":"t1"}"#))
        let activity = ActivityPayload(payload: envelope.payload)
        XCTAssertEqual(activity?.phase, .error)
        XCTAssertEqual(activity?.label, "turn")
        XCTAssertEqual(activity?.detail, "LLM 网络失败")
        XCTAssertEqual(activity?.traceId, "t1")
    }

    /// phase 2003 Step F：错误族新 phase（interrupted/retry/blocked）与 sinceMs 解码。
    func testDecodesErrorFamilyPhasesAndSinceMs() throws {
        for rawPhase in ["interrupted", "retry", "blocked"] {
            let envelope = try decoder.decode(line: line("activity", payload: #"{"phase":"\#(rawPhase)","detail":"[motion] ✗ x","sinceMs":1700000000000}"#))
            let activity = ActivityPayload(payload: envelope.payload)
            XCTAssertEqual(activity?.phase.rawValue, rawPhase)
            XCTAssertEqual(activity?.detail, "[motion] ✗ x")
            XCTAssertEqual(activity?.sinceMs, 1_700_000_000_000, "sinceMs 必须解码（duration 统一时间原点）")
        }
        // sinceMs 缺省为 nil（旧 producer 兼容）
        let legacy = try decoder.decode(line: line("activity", payload: #"{"phase":"error","detail":"x"}"#))
        XCTAssertNil(ActivityPayload(payload: legacy.payload)?.sinceMs)
    }
}
