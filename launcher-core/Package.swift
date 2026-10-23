// swift-tools-version: 5.8
import PackageDescription

// launcher-core：平台无关核心。不依赖 SwiftUI/AppKit/Process 等平台 API；
// Windows/Linux 外壳未来复用本 package，不复制业务状态机。
let package = Package(
    name: "launcher-core",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "LauncherCore", targets: ["LauncherCore"]),
    ],
    targets: [
        .target(name: "LauncherCore"),
        .testTarget(name: "LauncherCoreTests", dependencies: ["LauncherCore"]),
    ]
)
