import AppKit
import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

final class AccessibilityContractTests: XCTestCase {
    private let fixture = #"""
    {
      "protocol": "chestnut.ui.v1",
      "locale": "zh-CN",
      "screens": {
        "setup.provider": {"id":"setup.provider","title":"选择服务供应商","step":"第 1 步，共 3 步","status":"共 N 个服务供应商","hint":"下方还有供应商，可滚动查看"},
        "chat": {"id":"chat","title":"Motion 对话"}
      },
      "fields": {
        "credentials.apiKey": {"id":"credentials.apiKey","label":"API Key","placeholder":"API Key","secure":true,"required":true},
        "credentials.model": {"id":"credentials.model","label":"模型名称","placeholder":"模型名称","required":true,"hint":"默认模型：gpt-test"},
        "chat.composer": {"id":"chat.composer","label":"询问 Motion…","placeholder":"询问 Motion…"}
      },
      "actions": {
        "provider.submit": {"id":"provider.submit","label":"继续","enabledWhen":["provider.selected"],"disabledReason":"请选择供应商"},
        "chat.retry": {"id":"chat.retry","label":"重试"},
        "chat.close": {"id":"chat.close","label":"关闭"}
      },
      "states": {
        "activity.waiting": {"id":"activity.waiting","label":"Thinking…","busy":true},
        "activity.thinking": {"id":"activity.thinking","label":"Thinking…","busy":true},
        "activity.responding": {"id":"activity.responding","label":"Streaming…","busy":true},
        "activity.tool": {"id":"activity.tool","label":"Tool…","busy":true},
        "activity.error": {"id":"activity.error","label":"error","tone":"error"},
        "chat.system": {"id":"chat.system","label":"系统"}
      },
      "errors": {
        "setup.auth": {"id":"setup.auth","label":"无法验证配置。请检查 API Key，或修改配置后重试。"}
      }
    }
    """#

    private func decodeFixture() throws -> LauncherUiSemantics {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(fixture.utf8))
        return try XCTUnwrap(LauncherUiSemantics.decode(value))
    }

    func testFixtureDecodeAndLegacyAbsence() throws {
        let semantics = try decodeFixture()
        XCTAssertEqual(semantics.protocolVersion, "chestnut.ui.v1")
        XCTAssertEqual(semantics.locale, "zh-CN")
        XCTAssertEqual(semantics.screens["setup.provider"]?.title, "选择服务供应商")
        XCTAssertEqual(semantics.fields["credentials.apiKey"]?.secure, true)
        XCTAssertEqual(semantics.actions["provider.submit"]?.enabledWhen, ["provider.selected"])
        XCTAssertEqual(semantics.states["activity.error"]?.tone, .error)
        XCTAssertNil(try LauncherUiSemantics.decode(nil))
    }

    func testMalformedPresentSemanticsFailsClosed() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"protocol":"chestnut.ui.v1"}"#.utf8))
        XCTAssertThrowsError(try LauncherUiSemantics.decode(value)) { error in
            guard case ChatError.protocolMismatch = error else {
                return XCTFail("expected protocolMismatch, got \(error)")
            }
        }
    }

    @MainActor
    func testNativeProjectionLabelRoleFocusAndEnabled() throws {
        let projection = NativeAccessibilityProjection(
            identifier: "credentials.model",
            label: "模型名称",
            hint: "默认模型：gpt-test",
            role: .textField,
            enabled: false,
            focused: true
        )
        let view = NSView(frame: .zero)
        projection.apply(to: view)
        XCTAssertEqual(view.accessibilityIdentifier(), projection.identifier)
        XCTAssertEqual(view.accessibilityLabel(), "模型名称")
        XCTAssertEqual(view.accessibilityHelp(), "默认模型：gpt-test")
        XCTAssertEqual(view.accessibilityRole(), .textField)
        XCTAssertFalse(projection.enabled)
        XCTAssertTrue(projection.focused)
    }

    @MainActor
    func testSecureProjectionHasNoValueOrSecret() throws {
        let semantics = try decodeFixture()
        let secret = "sk-phase2023-secret"
        let field = try XCTUnwrap(semantics.fields["credentials.apiKey"])
        let projection = NativeAccessibilityProjection(
            identifier: field.id,
            label: field.label,
            hint: field.hint,
            role: .secureTextField,
            focused: true
        )
        let storedProperties = Mirror(reflecting: projection).children.compactMap(\.label)
        XCTAssertFalse(storedProperties.contains("value"))
        XCTAssertFalse(String(describing: projection).contains(secret))

        let secureField = NSSecureTextField(frame: .zero)
        secureField.stringValue = secret
        projection.apply(to: secureField)
        XCTAssertEqual(secureField.accessibilityRole(), .textField)
        XCTAssertFalse(String(describing: projection).contains(secret))
        XCTAssertFalse(String(describing: secureField.accessibilityValue()).contains(secret))
    }

    func testChatComposerActivityAndErrorMappings() throws {
        let semantics = try decodeFixture()
        let copy = SetupPresentationCopy(semantics: semantics)
        XCTAssertEqual(copy.field("chat.composer").label, "询问 Motion…")
        XCTAssertEqual(copy.action("chat.retry").label, "重试")
        XCTAssertEqual(copy.action("chat.close").label, "关闭")
        XCTAssertEqual(copy.state("chat.system").label, "系统")
        XCTAssertEqual(ActivityStyle.text(for: .waiting, semantics: semantics), "Thinking…")
        XCTAssertEqual(ActivityStyle.text(for: .responding, semantics: semantics), "Streaming…")
        XCTAssertEqual(ActivityStyle.text(for: .processing(label: "tool", detail: nil), semantics: semantics), "Tool…")
        XCTAssertEqual(ActivityStyle.text(for: .error(detail: nil), semantics: semantics), "error")
        XCTAssertEqual(
            copy.failure(SetupFailure(errorType: "auth", message: "raw secret")).label,
            "无法验证配置。请检查 API Key，或修改配置后重试。"
        )
    }

    func testActivityDetailRulesRemainUnchangedWithSemantics() throws {
        let semantics = try decodeFixture()
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "thinking", detail: "摘要"), semantics: semantics),
            "(摘要)"
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "text", detail: "正文"), semantics: semantics),
            "\"正文\""
        )
        XCTAssertEqual(
            ActivityStyle.text(for: .processing(label: "tool", detail: "search"), semantics: semantics),
            "search"
        )
        XCTAssertEqual(ActivityStyle.text(for: .error(detail: "wire detail"), semantics: semantics), "wire detail")
    }
}
