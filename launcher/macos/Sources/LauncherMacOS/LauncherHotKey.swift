import Carbon
import Foundation

/// Option-Space 的唯一快捷键定义；Carbon 注册不需要辅助功能权限。
enum LauncherHotKey {
    static let keyCode: UInt32 = 49 // Space
    static let modifiers: UInt32 = UInt32(optionKey)
    static let signature: OSType = 0x43484E54 // CHNT
    static let id: UInt32 = 1
}

enum LauncherHotKeyError: Error {
    case handlerInstallationFailed(OSStatus)
    case registrationFailed(OSStatus)
}

private let launcherHotKeyHandler: EventHandlerUPP = { _, event, userData in
    guard let event, GetEventKind(event) == UInt32(kEventHotKeyPressed), let userData else {
        return OSStatus(eventNotHandledErr)
    }
    let controller = Unmanaged<LauncherHotKeyController>.fromOpaque(userData).takeUnretainedValue()
    controller.handleHotKeyPress()
    return noErr
}

/// 持有 Carbon handler/hotKey 生命周期。回调只通知 owner，不触碰聊天状态。
final class LauncherHotKeyController {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let onPress: () -> Void

    init(onPress: @escaping () -> Void) {
        self.onPress = onPress
    }

    func start() throws {
        guard hotKeyRef == nil, handlerRef == nil else { return }

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        var installedHandler: EventHandlerRef?
        let installStatus = InstallEventHandler(
            GetEventDispatcherTarget(),
            launcherHotKeyHandler,
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &installedHandler
        )
        guard installStatus == noErr else {
            throw LauncherHotKeyError.handlerInstallationFailed(installStatus)
        }
        handlerRef = installedHandler

        let hotKeyID = EventHotKeyID(signature: LauncherHotKey.signature, id: LauncherHotKey.id)
        var registeredHotKey: EventHotKeyRef?
        let registerStatus = RegisterEventHotKey(
            LauncherHotKey.keyCode,
            LauncherHotKey.modifiers,
            hotKeyID,
            GetEventDispatcherTarget(),
            0,
            &registeredHotKey
        )
        guard registerStatus == noErr else {
            if let installedHandler { RemoveEventHandler(installedHandler) }
            handlerRef = nil
            throw LauncherHotKeyError.registrationFailed(registerStatus)
        }
        hotKeyRef = registeredHotKey
    }

    func stop() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        hotKeyRef = nil
        if let handlerRef { RemoveEventHandler(handlerRef) }
        handlerRef = nil
    }

    func handleHotKeyPress() {
        onPress()
    }

    deinit {
        stop()
    }
}
