import AppKit
import Foundation
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
        field.stringValue = "\nPASTE_FIXTURE_NOT_A_REAL_KEY\r\n"
        field.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
        XCTAssertEqual(draft, "PASTE_FIXTURE_NOT_A_REAL_KEY")
        XCTAssertEqual(field.stringValue, draft)
        XCTAssertEqual(submissions, 0)
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
}
