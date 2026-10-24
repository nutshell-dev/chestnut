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
}
