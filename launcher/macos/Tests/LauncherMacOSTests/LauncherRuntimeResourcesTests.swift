import Foundation
import XCTest
@testable import LauncherMacOS

final class LauncherRuntimeResourcesTests: XCTestCase {
    private var fixtureDir: URL!

    override func setUpWithError() throws {
        fixtureDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phase2026-resources-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixtureDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let fixtureDir { try? FileManager.default.removeItem(at: fixtureDir) }
    }

    private func makeBundle() throws -> Bundle {
        let app = fixtureDir.appendingPathComponent("Fixture App.app")
        let resources = app.appendingPathComponent("Contents/Resources")
        let node = resources.appendingPathComponent("node/bin/node")
        let cli = resources.appendingPathComponent("chestnut-cli/dist/cli.js")
        let fm = FileManager.default
        try fm.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\nexit 0\n".write(to: node, atomically: true, encoding: .utf8)
        try "// fixture\n".write(to: cli, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>dev.nutshell.chestnut.tests</string>
        <key>CFBundleExecutable</key><string>chestnut-launcher</string>
        </dict></plist>
        """
        try plist.write(to: app.appendingPathComponent("Contents/Info.plist"), atomically: true, encoding: .utf8)
        guard let bundle = Bundle(path: app.path) else { throw FixtureError.invalidBundle }
        return bundle
    }

    private enum FixtureError: Error { case invalidBundle }

    private func resolver(bundle: Bundle, environment: [String: String] = [:]) throws -> LauncherRuntimeResources {
        try LauncherRuntimeResources.resolve(
            environment: environment,
            bundle: bundle,
            fileSystem: LauncherFileSystem(homeDirectoryURL: fixtureDir.appendingPathComponent("home"))
        )
    }

    func testNoEnvironmentUsesBundledRuntimeAndDefaultUserRoot() throws {
        let bundle = try makeBundle()
        let resources = try resolver(bundle: bundle)
        XCTAssertEqual(resources.nodeURL.path, bundle.resourceURL!.appendingPathComponent("node/bin/node").path)
        XCTAssertEqual(resources.cliURL.path, bundle.resourceURL!.appendingPathComponent("chestnut-cli/dist/cli.js").path)
        XCTAssertEqual(
            resources.rootURL.path,
            fixtureDir.appendingPathComponent("home/Library/Application Support/Chestnut").path
        )
        XCTAssertFalse(resources.rootURL.path.contains(".app/Contents"))
        XCTAssertTrue(FileManager.default.isWritableFile(atPath: resources.rootURL.path))
        XCTAssertEqual(resources.processEnvironment, ["CHESTNUT_ROOT": resources.rootURL.path])
    }

    func testExplicitDevelopmentOverridesWinOverBundle() throws {
        let bundle = try makeBundle()
        let overrides = fixtureDir.appendingPathComponent("overrides")
        let node = overrides.appendingPathComponent("custom node")
        let cli = overrides.appendingPathComponent("custom cli.js")
        let root = overrides.appendingPathComponent("custom root")
        let fm = FileManager.default
        try fm.createDirectory(at: overrides, withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: node, atomically: true, encoding: .utf8)
        try "console.log('ok')\n".write(to: cli, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)

        let resources = try resolver(bundle: bundle, environment: [
            "CHESTNUT_NODE": node.path,
            "CHESTNUT_CLI_JS": cli.path,
            "CHESTNUT_ROOT": root.path,
        ])
        XCTAssertEqual(resources.nodeURL, node)
        XCTAssertEqual(resources.cliURL, cli)
        XCTAssertEqual(resources.rootURL, root)
        XCTAssertFalse(resources.rootURL.path.contains(".app/Contents"))
    }

    func testMissingNodeIsStructuredAndDoesNotFallBackToSystemNode() throws {
        let bundle = try makeBundle()
        try FileManager.default.removeItem(at: bundle.resourceURL!.appendingPathComponent("node/bin/node"))
        XCTAssertThrowsError(try resolver(bundle: bundle)) { error in
            guard case let .nodeMissing(path) = error as? LauncherRuntimeResourceError else {
                return XCTFail("expected nodeMissing, got \(error)")
            }
            XCTAssertTrue(path.contains("Fixture App.app/Contents/Resources/node/bin/node"))
            XCTAssertFalse(path.hasSuffix("/usr/bin/node"))
        }
    }

    func testMissingCLIIsStructuredAndDoesNotFallBackToCwd() throws {
        let bundle = try makeBundle()
        try FileManager.default.removeItem(at: bundle.resourceURL!.appendingPathComponent("chestnut-cli/dist/cli.js"))
        XCTAssertThrowsError(try resolver(bundle: bundle)) { error in
            guard case let .cliMissing(path) = error as? LauncherRuntimeResourceError else {
                return XCTFail("expected cliMissing, got \(error)")
            }
            XCTAssertTrue(path.contains("Fixture App.app/Contents/Resources/chestnut-cli/dist/cli.js"))
        }
    }

    func testNonExecutableNodeIsDistinctFromMissingNode() throws {
        let bundle = try makeBundle()
        let node = bundle.resourceURL!.appendingPathComponent("node/bin/node")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: node.path)
        XCTAssertThrowsError(try resolver(bundle: bundle)) { error in
            guard case .nodeNotExecutable = error as? LauncherRuntimeResourceError else {
                return XCTFail("expected nodeNotExecutable, got \(error)")
            }
        }
    }

    func testRootFileAndUnwritableRootHaveDistinctErrors() throws {
        let bundle = try makeBundle()
        let root = fixtureDir.appendingPathComponent("root-file")
        try "not a directory".write(to: root, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try resolver(bundle: bundle, environment: ["CHESTNUT_ROOT": root.path])) { error in
            guard case .rootNotDirectory = error as? LauncherRuntimeResourceError else {
                return XCTFail("expected rootNotDirectory, got \(error)")
            }
        }

        let readOnly = fixtureDir.appendingPathComponent("read-only-root")
        let fs = UnwritableRootFileSystem(base: LauncherFileSystem(), deniedRoot: readOnly)
        XCTAssertThrowsError(try LauncherRuntimeResources.resolve(
            environment: ["CHESTNUT_ROOT": readOnly.path],
            bundle: bundle,
            fileSystem: fs
        )) { error in
            guard case .rootNotWritable = error as? LauncherRuntimeResourceError else {
                return XCTFail("expected rootNotWritable, got \(error)")
            }
        }
    }
}

private struct UnwritableRootFileSystem: LauncherRuntimeFileSystem {
    let base: LauncherFileSystem
    let deniedRoot: URL
    var homeDirectoryForCurrentUser: URL { base.homeDirectoryForCurrentUser }
    func isFile(atPath path: String) -> Bool { base.isFile(atPath: path) }
    func isReadableFile(atPath path: String) -> Bool { base.isReadableFile(atPath: path) }
    func isExecutableFile(atPath path: String) -> Bool { base.isExecutableFile(atPath: path) }
    func isWritableFile(atPath path: String) -> Bool { path == deniedRoot.path ? false : base.isWritableFile(atPath: path) }
    func createDirectory(at url: URL, withIntermediateDirectories createIntermediates: Bool) throws {
        try base.createDirectory(at: url, withIntermediateDirectories: createIntermediates)
    }
}
