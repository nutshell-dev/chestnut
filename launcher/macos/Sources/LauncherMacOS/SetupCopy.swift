import LauncherCore

/// 初始化界面的用户文案唯一来源。内部错误分类只用于选择可执行文案，
/// 原始 detail 和秘密继续留在 CLI/audit，不进入 SwiftUI。
enum SetupCopy {
    static let setupTitle = "首次初始化"
    static let providerStep = "第 1 步，共 2 步"
    static let credentialsStep = "第 2 步，共 2 步"
    static let providerTitle = "选择服务供应商"
    static let providerSubtitle = "选择用于 Motion 的模型服务。"
    static let credentialsTitle = "配置模型与凭据"
    static let probingTitle = "正在验证配置"
    static let repairTitle = "需要调整配置"
    static let startingTitle = "正在启动 Motion"
    static let startFailureTitle = "Motion 尚未启动"
    static let committedTitle = "配置已保存"
    static let pleaseWait = "请稍候…"
    static let readySubtitle = "即将进入对话。"

    static let continueAction = "继续"
    static let submitAction = "验证并继续"
    static let retryAction = "重试"
    static let retryStartAction = "重试启动"
    static let recheckAction = "重新检查"
    static let editAction = "修改配置"
    static let cancelAction = "取消"

    static let modelLabel = "模型"
    static let apiKeyLabel = "API Key"
    static let baseURLLabel = "Base URL"
    static let localKeyPlaceholder = "本地服务无需 API Key"

    static func credentialsSubtitle(for provider: SetupProvider) -> String {
        provider.description
    }

    static func probingSubtitle(provider: String, model: String) -> String {
        "正在验证 \(provider) / \(model)，请稍候。"
    }

    static func failure(_ failure: SetupFailure) -> String {
        switch failure.errorType {
        case "auth":
            return "验证失败，请检查 API Key 后重试。"
        case "network":
            return "暂时无法连接服务，请检查网络后重试。"
        case "start":
            return "配置已保存，但 Motion 启动失败。请重试启动。"
        case "transport":
            return "暂时无法连接 Chestnut，请重新检查。"
        default:
            return "验证失败，请检查配置后重试。"
        }
    }
}
