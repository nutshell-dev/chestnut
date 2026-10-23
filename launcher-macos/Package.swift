// swift-tools-version: 5.8
import PackageDescription

// launcher-macos：macOS 外壳。SwiftUI 视图 + AppKit 标准 NSWindow + Process 子进程适配。
// 业务状态机、协议解码、失败恢复全部在 launcher-core，本 package 只做平台适配。
let package = Package(
    name: "launcher-macos",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "chestnut-launcher", targets: ["LauncherMacOS"]),
    ],
    dependencies: [
        .package(path: "../launcher-core"),
    ],
    targets: [
        .executableTarget(
            name: "LauncherMacOS",
            dependencies: [.product(name: "LauncherCore", package: "launcher-core")]
        ),
        .testTarget(
            name: "LauncherMacOSTests",
            dependencies: ["LauncherMacOS"]
        ),
    ]
)
