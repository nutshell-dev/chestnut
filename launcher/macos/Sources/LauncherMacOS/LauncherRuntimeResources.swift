import Foundation

/// 文件系统边界保持可注入：测试不读取真实 HOME，也不依赖 Bundle.main。
protocol LauncherRuntimeFileSystem {
    var homeDirectoryForCurrentUser: URL { get }
    func isFile(atPath path: String) -> Bool
    func isReadableFile(atPath path: String) -> Bool
    func isExecutableFile(atPath path: String) -> Bool
    func isWritableFile(atPath path: String) -> Bool
    func createDirectory(at url: URL, withIntermediateDirectories createIntermediates: Bool) throws
}

struct LauncherFileSystem: LauncherRuntimeFileSystem {
    let fileManager: FileManager
    let homeDirectoryURL: URL?

    init(fileManager: FileManager = .default, homeDirectoryURL: URL? = nil) {
        self.fileManager = fileManager
        self.homeDirectoryURL = homeDirectoryURL
    }

    var homeDirectoryForCurrentUser: URL {
        homeDirectoryURL ?? fileManager.homeDirectoryForCurrentUser
    }

    func isFile(atPath path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
    }

    func isReadableFile(atPath path: String) -> Bool { fileManager.isReadableFile(atPath: path) }
    func isExecutableFile(atPath path: String) -> Bool { fileManager.isExecutableFile(atPath: path) }
    func isWritableFile(atPath path: String) -> Bool { fileManager.isWritableFile(atPath: path) }

    func createDirectory(at url: URL, withIntermediateDirectories createIntermediates: Bool) throws {
        try fileManager.createDirectory(at: url, withIntermediateDirectories: createIntermediates)
    }
}

enum LauncherRuntimeResourceError: Error, Equatable {
    case nodeMissing(String)
    case nodeNotExecutable(String)
    case cliMissing(String)
    case cliNotReadable(String)
    case rootNotDirectory(String)
    case rootCreationFailed(path: String, detail: String)
    case rootNotWritable(String)

    /// 本地结构化错误的用户呈现；包含具体资源和可执行的修复方向。
    var detail: String {
        switch self {
        case let .nodeMissing(path):
            return "Chestnut Node runtime 缺失：\(path)。请重新构建或安装完整应用。"
        case let .nodeNotExecutable(path):
            return "Chestnut Node runtime 不可执行：\(path)。请检查文件权限、CPU 架构与应用完整性。"
        case let .cliMissing(path):
            return "Chestnut CLI 资源缺失：\(path)。请重新构建或安装完整应用。"
        case let .cliNotReadable(path):
            return "Chestnut CLI 资源不可读：\(path)。请检查文件权限与应用完整性。"
        case let .rootNotDirectory(path):
            return "Chestnut 用户数据路径不是目录：\(path)。请移走同名文件后重试。"
        case let .rootCreationFailed(path, detail):
            return "Chestnut 用户数据目录创建失败：\(path)；\(detail)。请检查父目录权限。"
        case let .rootNotWritable(path):
            return "Chestnut 用户数据目录不可写：\(path)。请检查目录权限后重试。"
        }
    }
}

struct LauncherRuntimeResources {
    let nodeURL: URL
    let cliURL: URL
    let rootURL: URL

    var processEnvironment: [String: String] { ["CHESTNUT_ROOT": rootURL.path] }

    /// 显式开发覆盖优先；缺省只使用 app bundle，不回退 cwd 或系统 Node。
    static func resolve(
        environment: [String: String],
        bundle: Bundle = .main,
        fileSystem: any LauncherRuntimeFileSystem = LauncherFileSystem()
    ) throws -> LauncherRuntimeResources {
        let resourceURL = bundle.resourceURL
        let bundledNodePath = "\(bundle.bundlePath)/Contents/Resources/node/bin/node"
        let bundledCLIPath = "\(bundle.bundlePath)/Contents/Resources/chestnut-cli/dist/cli.js"
        guard let nodeURL = overrideURL(environment["CHESTNUT_NODE"])
            ?? resourceURL?.appendingPathComponent("node/bin/node", isDirectory: false) else {
            throw LauncherRuntimeResourceError.nodeMissing(bundledNodePath)
        }
        guard let cliURL = overrideURL(environment["CHESTNUT_CLI_JS"])
            ?? resourceURL?.appendingPathComponent("chestnut-cli/dist/cli.js", isDirectory: false) else {
            throw LauncherRuntimeResourceError.cliMissing(bundledCLIPath)
        }
        let rootURL = overrideURL(environment["CHESTNUT_ROOT"])
            ?? fileSystem.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Chestnut", isDirectory: true)

        guard fileSystem.isFile(atPath: nodeURL.path) else {
            throw LauncherRuntimeResourceError.nodeMissing(nodeURL.path)
        }
        guard fileSystem.isExecutableFile(atPath: nodeURL.path) else {
            throw LauncherRuntimeResourceError.nodeNotExecutable(nodeURL.path)
        }
        guard fileSystem.isFile(atPath: cliURL.path) else {
            throw LauncherRuntimeResourceError.cliMissing(cliURL.path)
        }
        guard fileSystem.isReadableFile(atPath: cliURL.path) else {
            throw LauncherRuntimeResourceError.cliNotReadable(cliURL.path)
        }

        if fileSystem.isFile(atPath: rootURL.path) {
            throw LauncherRuntimeResourceError.rootNotDirectory(rootURL.path)
        }
        do {
            try fileSystem.createDirectory(at: rootURL, withIntermediateDirectories: true)
        } catch {
            throw LauncherRuntimeResourceError.rootCreationFailed(
                path: rootURL.path,
                detail: error.localizedDescription
            )
        }
        guard fileSystem.isWritableFile(atPath: rootURL.path) else {
            throw LauncherRuntimeResourceError.rootNotWritable(rootURL.path)
        }

        return LauncherRuntimeResources(nodeURL: nodeURL, cliURL: cliURL, rootURL: rootURL)
    }

    private static func overrideURL(_ value: String?) -> URL? {
        guard let value, !value.isEmpty else { return nil }
        return URL(fileURLWithPath: value).standardizedFileURL
    }
}
