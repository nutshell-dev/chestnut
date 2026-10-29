import LauncherCore

/// 初始化界面的用户文案唯一来源。内部错误分类只用于选择可执行文案，
/// 原始 detail 和秘密继续留在 CLI/audit，不进入 SwiftUI。
enum SetupCopy {
    static let setupTitle = "首次初始化"
    static let providerStep = "第 1 步，共 3 步"
    static let credentialsStep = "第 2 步，共 3 步"
    static let languageStep = "第 3 步，共 3 步"
    static let providerTitle = "选择服务供应商"
    static let providerSubtitle = "选择用于 Motion 的模型服务。"
    static let moreProvidersHint = "下方还有供应商，可滚动查看"

    static func providerCount(_ count: Int) -> String {
        "共 \(count) 个服务供应商"
    }
    static let credentialsTitle = "配置模型与凭据"
    static let probingTitle = "正在连接并验证配置"
    static let repairTitle = "需要调整配置"
    static let startingTitle = "正在启动 Motion"
    static let startFailureTitle = "Motion 尚未启动"
    static let committedTitle = "配置已保存"
    static let languageTitle = "Select language / 选择语言"
    static let languageSubtitle = "type any word for auto-detect (e.g. hello, 你好)"
    static let languageLabel = "语言样本"
    static let languagePlaceholder = "留空自动检测；或输入 hello、你好等"
    static let languageAction = "启动 Motion"
    static let pleaseWait = "请稍候…"
    static let readySubtitle = "配置已保存，即将进入对话。"

    static let continueAction = "继续"
    static let submitAction = "验证并保存配置"
    static let retryAction = "重试"
    static let retryStartAction = "重试启动"
    static let recheckAction = "重新检查"
    static let editAction = "修改配置"
    static let cancelAction = "退出设置"
    static let backAction = "返回上一步"

    static let modelLabel = "模型名称"
    static let apiKeyLabel = "API Key"
    static let baseURLLabel = "Base URL（自定义服务地址）"
    static let localKeyPlaceholder = "本地服务无需 API Key"

    static func defaultModelHint(_ model: String?) -> String {
        guard let model, !model.isEmpty else { return "模型名称由 CLI 预填，可直接使用。" }
        return "默认模型：\(model)，可直接使用"
    }

    static func credentialsSubtitle(for provider: SetupProvider) -> String {
        "\(provider.description)。填写配置后，验证通过才会保存。"
    }

    static let probingSubtitle = "正在连接服务并验证当前配置，请稍候。"

    static func failure(_ failure: SetupFailure) -> String {
        switch failure.errorType {
        case "auth":
            return "无法验证配置。请检查 API Key，或修改配置后重试。"
        case "network":
            return "无法验证配置：当前无法连接服务。请检查网络或 Base URL 后重试。"
        case "start":
            return "配置已保存，但 Motion 启动失败。请重试启动。"
        case "transport":
            return "暂时无法连接 Chestnut，请重新检查。"
        default:
            return "无法验证配置。请检查模型、Base URL 或服务设置后重试。"
        }
    }
}


extension SetupCopy {
    static func screen(_ id: String, semantics: LauncherUiSemantics?) -> UiScreen {
        if let screen = semantics?.screens[id] { return screen }
        switch id {
        case "setup.provider":
            return UiScreen(id: id, title: providerTitle, step: providerStep, subtitle: providerSubtitle,
                            status: "共 N 个服务供应商", hint: moreProvidersHint)
        case "setup.credentials":
            return UiScreen(id: id, title: credentialsTitle, step: credentialsStep)
        case "setup.probing":
            return UiScreen(id: id, title: probingTitle, subtitle: probingSubtitle)
        case "setup.repair":
            return UiScreen(id: id, title: repairTitle)
        case "setup.starting":
            return UiScreen(id: id, title: startingTitle)
        case "setup.start_failure":
            return UiScreen(id: id, title: startFailureTitle)
        case "setup.language":
            return UiScreen(id: id, title: languageTitle, step: languageStep, subtitle: languageSubtitle)
        case "chat":
            return UiScreen(id: id, title: "Motion 对话")
        default:
            return UiScreen(id: id, title: id)
        }
    }

    static func field(_ id: String, semantics: LauncherUiSemantics?) -> UiField {
        if let field = semantics?.fields[id] { return field }
        switch id {
        case "credentials.apiKey":
            return UiField(id: id, label: apiKeyLabel, placeholder: apiKeyLabel, secure: true, required: true)
        case "credentials.model":
            return UiField(id: id, label: modelLabel, placeholder: modelLabel, required: true)
        case "credentials.baseUrl":
            return UiField(id: id, label: baseURLLabel, placeholder: baseURLLabel)
        case "setup.language":
            return UiField(id: id, label: languageLabel, placeholder: languagePlaceholder)
        case "chat.composer":
            return UiField(id: id, label: ComposerStyle.placeholder, placeholder: ComposerStyle.placeholder)
        default:
            return UiField(id: id, label: id)
        }
    }

    static func action(_ id: String, semantics: LauncherUiSemantics?) -> UiAction {
        if let action = semantics?.actions[id] { return action }
        let label: String
        switch id {
        case "provider.submit": label = continueAction
        case "credentials.submit": label = submitAction
        case "credentials.back": label = backAction
        case "credentials.cancel", "repair.cancel": label = cancelAction
        case "repair.retry": label = retryAction
        case "repair.edit": label = editAction
        case "start.retry": label = retryStartAction
        case "status.recheck": label = recheckAction
        case "language.submit": label = languageAction
        case "chat.send", "chat.retry": label = id == "chat.send" ? "发送" : retryAction
        case "chat.close": label = "关闭"
        case "chat.interrupt": label = "中断"
        default: label = id
        }
        return UiAction(id: id, label: label)
    }

    static func state(_ id: String, semantics: LauncherUiSemantics?) -> UiState {
        if let state = semantics?.states[id] { return state }
        let label: String
        switch id {
        case "setup.waiting": label = pleaseWait
        case "setup.ready": label = readySubtitle
        case "chat.system": label = "系统"
        case "activity.waiting", "activity.thinking": label = "Thinking…"
        case "activity.responding": label = "Streaming…"
        case "activity.tool": label = "Tool…"
        case "activity.error": label = "error"
        case "activity.interrupted": label = "interrupted"
        case "activity.retry": label = "retrying"
        case "activity.blocked": label = "blocked"
        default: label = id
        }
        return UiState(id: id, label: label)
    }

    static func error(_ id: String, failure: SetupFailure, semantics: LauncherUiSemantics?) -> UiError {
        if let error = semantics?.errors[id] { return error }
        return UiError(id: id, label: self.failure(failure))
    }
}

/// View-facing copy projection. Every lookup prefers CLI semantics and uses the legacy
/// constants above only when an older SetupClient returned no semantics.
struct SetupPresentationCopy {
    let semantics: LauncherUiSemantics?

    func screen(_ id: String) -> UiScreen { SetupCopy.screen(id, semantics: semantics) }
    func field(_ id: String) -> UiField { SetupCopy.field(id, semantics: semantics) }
    func action(_ id: String) -> UiAction { SetupCopy.action(id, semantics: semantics) }
    func state(_ id: String) -> UiState { SetupCopy.state(id, semantics: semantics) }

    func providerCount(_ count: Int) -> String {
        let status = screen("setup.provider").status ?? SetupCopy.providerCount(count)
        return status.replacingOccurrences(of: "N", with: "\(count)")
    }

    func credentialsSubtitle(for provider: SetupProvider) -> String {
        screen("setup.credentials").subtitle ?? SetupCopy.credentialsSubtitle(for: provider)
    }

    func defaultModelHint(_ model: String?) -> String {
        field("credentials.model").hint ?? SetupCopy.defaultModelHint(model)
    }

    func failure(_ failure: SetupFailure) -> UiError {
        let knownTypes = ["auth", "network", "start", "transport"]
        let type = knownTypes.contains(failure.errorType) ? failure.errorType : "unknown"
        return SetupCopy.error("setup.\(type)", failure: failure, semantics: semantics)
    }
}
