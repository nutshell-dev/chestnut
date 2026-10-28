import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import LauncherMacOS

private final class SetupPasteFixture: ObservableObject {
    @Published var text = ""
    @Published var focused = false
    var submissions = 0
}

private struct SetupPasteHost: View {
    @ObservedObject var store: SetupPasteFixture

    var body: some View {
        PasteCapableSecureField(
            text: Binding(get: { store.text }, set: { store.text = $0 }),
            placeholder: "API Key",
            isFocused: Binding(get: { store.focused }, set: { store.focused = $0 }),
            onSubmit: { store.submissions += 1 }
        )
        .frame(width: 300, height: 40)
    }
}

final class SetupPasteTests: XCTestCase {
    private var savedPasteboardContents: [[String: Any]] = []

    override func setUpWithError() throws {
        _ = NSApplication.shared
        savedPasteboardContents = (NSPasteboard.general.pasteboardItems ?? []).map { item in
            var contents: [String: Any] = [:]
            for type in item.types {
                if let value = item.propertyList(forType: type) { contents[type.rawValue] = value }
            }
            return contents
        }
        SetupPasteMenuTarget.install()
        NSApp.activate(ignoringOtherApps: true)
    }

    override func tearDownWithError() throws {
        NSPasteboard.general.clearContents()
        for contents in savedPasteboardContents {
            let item = NSPasteboardItem()
            for (type, value) in contents { item.setPropertyList(value, forType: NSPasteboard.PasteboardType(type)) }
            NSPasteboard.general.writeObjects([item])
        }
    }

    func testPasteNormalizationOnlyRemovesEdgeNewlines() {
        XCTAssertEqual(SetupPaste.normalize("\nPASTE_FIXTURE\r\n"), "PASTE_FIXTURE")
        XCTAssertEqual(SetupPaste.normalize("  PASTE FIXTURE  "), "  PASTE FIXTURE  ")
        XCTAssertEqual(SetupPaste.normalize("PASTE\nFIXTURE"), "PASTE\nFIXTURE")
    }

    func testWindowAttachRetriesUntilSecureFieldActuallyGetsEditor() {
        let store = SetupPasteFixture()
        let hosting = NSHostingView(rootView: SetupPasteHost(store: store))
        hosting.frame = NSRect(x: 0, y: 0, width: 320, height: 60)
        let window = makeWindow()
        var field: SetupSecureTextField?
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        XCTAssertTrue(waitFor {
            if field == nil {
                hosting.layoutSubtreeIfNeeded()
                field = self.findSecureField(in: hosting)
            }
            return field?.currentEditor() != nil
        }, "window attach 后必须真正建立 field editor")
        guard let field else { return XCTFail("missing wrapped secure field") }
        XCTAssertTrue(field.isEditable)
        XCTAssertTrue(field.isSelectable)
        window.orderOut(nil)
    }

    func testCommandVPastesThroughRealFieldEditorIntoBinding() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        setClipboard("COMMAND_V_FIXTURE")
        sendKey("v", keyCode: 9, command: true, to: context.window)
        XCTAssertTrue(waitFor { context.store.text == "COMMAND_V_FIXTURE" }, "Command-V 必须经 field editor 更新 Binding")
        XCTAssertEqual(context.field.stringValue, "COMMAND_V_FIXTURE")
        XCTAssertEqual(context.store.submissions, 0)
    }

    func testMenuPastePassesThroughRealResponderChainIntoBinding() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        setClipboard("MENU_PASTE_FIXTURE")
        XCTAssertTrue(SetupPasteMenuTarget.activeField === context.field, "菜单必须绑定当前 secure field")
        XCTAssertTrue(performMenuPaste())
        XCTAssertTrue(waitFor { context.store.text == "MENU_PASTE_FIXTURE" }, "菜单 Paste 必须经 responder chain 更新 Binding")
        XCTAssertEqual(context.field.stringValue, "MENU_PASTE_FIXTURE")
        XCTAssertEqual(context.store.submissions, 0)
    }

    func testContextMenuPastePassesThroughRealMenuActionIntoBinding() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        setClipboard("CONTEXT_PASTE_FIXTURE")
        let event = NSEvent.mouseEvent(
            with: .rightMouseDown,
            location: NSPoint(x: 12, y: 12),
            modifierFlags: [],
            timestamp: 0,
            windowNumber: context.window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        )!
        NSApp.sendEvent(event)
        guard waitFor({ context.field.lastContextMenu != nil }),
              let menu = context.field.lastContextMenu,
              let index = menu.items.firstIndex(where: { $0.action == #selector(NSText.paste) }) else {
            return XCTFail("right-click event must produce a Paste menu")
        }
        XCTAssertTrue(menu.items[index].target === context.field, "context Paste 必须路由到 secure field")
        menu.performActionForItem(at: index)
        XCTAssertTrue(waitFor { context.store.text == "CONTEXT_PASTE_FIXTURE" }, "右键 Paste 必须更新 Binding")
        XCTAssertEqual(context.field.stringValue, "CONTEXT_PASTE_FIXTURE")
        XCTAssertEqual(context.store.submissions, 0)
    }

    func testContinuousRealKeyEventsPreserveEveryCharacterAndFocus() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        guard let editor = context.field.currentEditor() else { return XCTFail("missing active field editor") }
        for (character, keyCode) in [("a", 0), ("b", 11), ("c", 8)] {
            sendKey(character, keyCode: UInt16(keyCode), to: context.window)
        }
        XCTAssertTrue(waitFor { context.store.text == "abc" })
        XCTAssertEqual(context.field.stringValue, "abc")
        XCTAssertTrue(context.field.currentEditor() === editor)
        XCTAssertTrue(context.window.firstResponder === editor)
    }

    func testPasteThenAppendDeleteAndSelectionReplacementUseRealEvents() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        setClipboard("PASTE_FIXTURE")
        XCTAssertTrue(performMenuPaste())
        XCTAssertTrue(waitFor { context.store.text == "PASTE_FIXTURE" })
        sendKey("x", keyCode: 7, to: context.window)
        XCTAssertTrue(waitFor { context.store.text == "PASTE_FIXTUREx" })
        sendKey("\u{7f}", keyCode: 51, to: context.window)
        XCTAssertTrue(waitFor { context.store.text == "PASTE_FIXTURE" })
        guard let editor = context.field.currentEditor() as? NSTextView else { return XCTFail("missing active text view") }
        editor.setSelectedRange(NSRange(location: 0, length: context.field.stringValue.count))
        sendKey("r", keyCode: 15, to: context.window)
        XCTAssertTrue(waitFor { context.store.text == "r" })
        XCTAssertEqual(context.field.stringValue, "r")
    }

    func testLongInputScrollsAndSurvivesFocusRoundTripWithoutTruncation() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        let longFixture = String(repeating: "LONG_FIXTURE_", count: 24)
        setClipboard(longFixture)
        XCTAssertTrue(performMenuPaste())
        XCTAssertTrue(waitFor { context.store.text == longFixture })
        XCTAssertEqual(context.field.stringValue, longFixture)
        XCTAssertFalse(context.field.cell?.wraps ?? true)
        XCTAssertTrue(context.field.cell?.isScrollable ?? false)

        sendKey("x", keyCode: 7, to: context.window)
        let expected = longFixture + "x"
        XCTAssertTrue(waitFor { context.store.text == expected })
        let other = NSTextField(frame: NSRect(x: 0, y: 0, width: 80, height: 20))
        context.window.contentView?.addSubview(other)
        XCTAssertTrue(context.window.makeFirstResponder(other))
        XCTAssertTrue(context.window.makeFirstResponder(context.field))
        XCTAssertEqual(context.store.text, expected)
        XCTAssertEqual(context.field.stringValue, expected)
        guard let refocusedEditor = context.field.currentEditor() as? NSTextView else {
            return XCTFail("missing editor after focus round trip")
        }
        XCTAssertTrue(waitFor { refocusedEditor.selectedRange().location == expected.count })
    }

    func testReturnSubmitsOnlyAfterRealPasteReachesBinding() {
        guard let context = makePasteWindow() else { return }
        defer { context.window.orderOut(nil) }
        setClipboard("RETURN_FIXTURE")
        XCTAssertTrue(performMenuPaste())
        XCTAssertTrue(waitFor { context.store.text == "RETURN_FIXTURE" })
        XCTAssertEqual(context.store.submissions, 0)
        sendKey("\r", keyCode: 36, to: context.window)
        XCTAssertTrue(waitFor { context.store.submissions == 1 })
    }

    private typealias PasteContext = (window: NSWindow, field: SetupSecureTextField, store: SetupPasteFixture)

    private func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
        return window
    }

    private func makePasteWindow() -> PasteContext? {
        let store = SetupPasteFixture()
        let hosting = NSHostingView(rootView: SetupPasteHost(store: store))
        let window = makeWindow()
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        hosting.layoutSubtreeIfNeeded()
        guard let field = findSecureField(in: hosting) else {
            XCTFail("missing wrapped secure field")
            return nil
        }
        XCTAssertTrue(window.makeFirstResponder(field))
        guard waitFor({ field.currentEditor() != nil }) else {
            XCTFail("secure field did not receive a real field editor")
            return nil
        }
        XCTAssertTrue(field.currentEditor() != nil)
        return (window, field, store)
    }

    private func findSecureField(in view: NSView) -> SetupSecureTextField? {
        if let field = view as? SetupSecureTextField { return field }
        for subview in view.subviews {
            if let field = findSecureField(in: subview) { return field }
        }
        return nil
    }

    private func performMenuPaste() -> Bool {
        guard let mainMenu = NSApp.mainMenu,
              let editItem = mainMenu.items.first(where: { $0.title == "Edit" }),
              let editMenu = editItem.submenu,
              let index = editMenu.items.firstIndex(where: { $0.action == #selector(NSText.paste) }) else { return false }
        editMenu.performActionForItem(at: index)
        return true
    }

    private func setClipboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private func sendKey(_ value: String, keyCode: UInt16, command: Bool = false, to window: NSWindow) {
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: command ? [.command] : [],
            timestamp: 0,
            windowNumber: window.windowNumber,
            context: nil,
            characters: value,
            charactersIgnoringModifiers: value,
            isARepeat: false,
            keyCode: keyCode
        )!
        if command {
            NSApp.sendEvent(event)
        } else {
            window.sendEvent(event)
        }
    }

    @discardableResult
    private func waitFor(_ condition: () -> Bool, timeout: TimeInterval = 2) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        return condition()
    }
}
