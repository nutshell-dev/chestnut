import AppKit
import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

final class SetupPasteTests: XCTestCase {
    override func setUpWithError() throws {
        _ = NSApplication.shared
    }

    func testPasteNormalizationOnlyRemovesEdgeNewlines() {
        XCTAssertEqual(SetupPaste.normalize("\nPASTE_FIXTURE\r\n"), "PASTE_FIXTURE")
        XCTAssertEqual(SetupPaste.normalize("  PASTE FIXTURE  "), "  PASTE FIXTURE  ")
        XCTAssertEqual(SetupPaste.normalize("PASTE\nFIXTURE"), "PASTE\nFIXTURE")
    }

    func testNativeSecureFieldEditorOwnsMenuAndContextPaste() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 60), styleMask: [.titled], backing: .buffered, defer: false)
        let field = SetupSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
        window.contentView = field
        window.makeKeyAndOrderFront(nil)
        XCTAssertTrue(window.makeFirstResponder(field))
        guard let editor = field.currentEditor() else { return XCTFail("secure field must own a native field editor") }
        XCTAssertTrue(field.isKind(of: NSSecureTextField.self))
        XCTAssertTrue(editor.responds(to: #selector(NSText.paste)), "Command-V、菜单和右键共用原生 paste responder")
        window.orderOut(nil)
    }

    func testPasteEquivalentChangeUpdatesDraftWithoutSubmitting() {
        let field = SetupSecureTextField(frame: .zero)
        var draft = ""
        var submissions = 0
        field.onTextChange = { draft = $0 }
        field.onSubmit = { submissions += 1 }
        edit("PASTE_FIXTURE_NOT_A_REAL_KEY", on: field)
        XCTAssertEqual(draft, "PASTE_FIXTURE_NOT_A_REAL_KEY")
        XCTAssertEqual(field.stringValue, draft)
        XCTAssertEqual(submissions, 0)
    }

    func testContinuousInputPreservesEveryIntermediateDraft() {
        let field = SetupSecureTextField(frame: .zero)
        var drafts: [String] = []
        var submissions = 0
        field.onTextChange = { drafts.append($0) }
        field.onSubmit = { submissions += 1 }
        for value in ["a", "ab", "abc"] { edit(value, on: field) }
        XCTAssertEqual(drafts, ["a", "ab", "abc"])
        XCTAssertEqual(submissions, 0)
    }

    func testPasteAppendDeleteAndSelectionReplacementRemainEditable() {
        let field = SetupSecureTextField(frame: .zero)
        var drafts: [String] = []
        field.onTextChange = { drafts.append($0) }
        for value in ["PASTE_FIXTURE", "PASTE_FIXTUREx", "PASTE_FIXTURE", "REPLACED"] {
            edit(value, on: field)
        }
        XCTAssertEqual(drafts, ["PASTE_FIXTURE", "PASTE_FIXTUREx", "PASTE_FIXTURE", "REPLACED"])
    }

    func testTextChangesDoNotReplaceFieldEditorOrFocus() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 60), styleMask: [.titled], backing: .buffered, defer: false)
        let field = SetupSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
        window.contentView = field
        window.makeKeyAndOrderFront(nil)
        XCTAssertTrue(window.makeFirstResponder(field))
        guard let editor = field.currentEditor() else { return XCTFail("missing field editor") }
        edit("a", on: field)
        edit("ab", on: field)
        XCTAssertTrue(field.currentEditor() === editor)
        XCTAssertTrue(window.firstResponder === editor)
        window.orderOut(nil)
    }

    func testEdgeNewlinesNormalizeAtSubmitNotDuringEditing() {
        let provider = SetupProvider(id: "fixture", label: "Fixture", description: "Fixture", auth: "api_key", defaultModel: "model")
        var draft = SetupDraft()
        draft.configure(provider: provider, modelDefault: nil, savedModel: nil)
        draft.apiKey = "\nPASTE_FIXTURE\r\n"
        let input = draft.consumeInput(provider: provider)
        XCTAssertEqual(input.apiKey, "PASTE_FIXTURE")
        XCTAssertTrue(draft.apiKey.isEmpty)
    }

    func testFocusAndSubmitCallbacksRemainIndependent() {
        let field = SetupSecureTextField(frame: .zero)
        var focused = false
        var submissions = 0
        field.onFocusChange = { focused = $0 }
        field.onSubmit = { submissions += 1 }
        field.controlTextDidBeginEditing(Notification(name: NSControl.textDidBeginEditingNotification, object: field))
        XCTAssertTrue(focused)
        field.controlTextDidEndEditing(Notification(name: NSControl.textDidEndEditingNotification, object: field))
        XCTAssertFalse(focused)
        field.sendAction(field.action!, to: field)
        XCTAssertEqual(submissions, 1)
    }

    private func edit(_ value: String, on field: SetupSecureTextField) {
        field.stringValue = value
        field.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
    }
}
