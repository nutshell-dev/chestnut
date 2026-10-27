import Carbon
import XCTest
@testable import LauncherMacOS

final class LauncherHotKeyTests: XCTestCase {
    func testOptionSpaceRegistrationConstants() {
        XCTAssertEqual(LauncherHotKey.keyCode, 49, "Space 的 macOS virtual key code")
        XCTAssertEqual(LauncherHotKey.modifiers, UInt32(optionKey))
        XCTAssertEqual(LauncherHotKey.signature, 0x43484E54)
        XCTAssertEqual(LauncherHotKey.id, 1)
    }

    func testHotKeyEventInvokesOnlyRegisteredCallback() {
        var count = 0
        let controller = LauncherHotKeyController { count += 1 }
        controller.handleHotKeyPress()
        controller.handleHotKeyPress()
        XCTAssertEqual(count, 2)
    }

    func testStopWithoutRegistrationIsIdempotent() {
        let controller = LauncherHotKeyController {}
        controller.stop()
        controller.stop()
    }
}
