import Foundation
import LauncherCore
import XCTest
@testable import LauncherMacOS

/// Step C：macOS Process 适配测试。fixture 为临时 shell 脚本（fake executable），
/// 不使用真实用户 workspace、凭据或 daemon。
final class ChestnutProcessTests: XCTestCase {
    private var fixtureDir: URL!

    override func setUpWithError() throws {
        fixtureDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phase1982-proc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixtureDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let fixtureDir {
            try? FileManager.default.removeItem(at: fixtureDir)
        }
    }

    private func makeScript(_ name: String, _ body: String) throws -> URL {
        let url = fixtureDir.appendingPathComponent(name)
        try body.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    // MARK: run（一次性）

    func testRunCollectsStdoutLinesAndExitZero() async throws {
        let script = try makeScript("ok.sh", "#!/bin/sh\necho line1\necho line2\nexit 0\n")
        let output = try await MacOSChestnutProcess(executableURL: script).run(["ignored"])
        XCTAssertEqual(output.stdoutLines, ["line1", "line2"])
        XCTAssertEqual(output.exitCode, 0)
        XCTAssertNil(output.terminationSignal)
    }

    func testRunCapturesNonZeroExitAndStderr() async throws {
        let script = try makeScript("fail.sh", "#!/bin/sh\necho partial-out\necho boom >&2\nexit 3\n")
        let output = try await MacOSChestnutProcess(executableURL: script).run([])
        XCTAssertEqual(output.exitCode, 3)
        XCTAssertEqual(output.stdoutLines, ["partial-out"])
        XCTAssertTrue(output.stderr.contains("boom"))
    }

    func testRunReportsSignalTermination() async throws {
        let script = try makeScript("sig.sh", "#!/bin/sh\nkill -TERM $$\n")
        let output = try await MacOSChestnutProcess(executableURL: script).run([])
        XCTAssertEqual(output.terminationSignal, Int32(SIGTERM))
    }

    func testRunLaunchFailureIsTransportError() async throws {
        let missing = fixtureDir.appendingPathComponent("no-such-executable")
        do {
            _ = try await MacOSChestnutProcess(executableURL: missing).run([])
            XCTFail("expected launch failure")
        } catch let error as ChatError {
            guard case .transport = error else {
                return XCTFail("expected transport, got \(error)")
            }
        }
    }

    // MARK: stream（长驻）

    func testStreamYieldsLinesAndFinishesOnExitZero() async throws {
        let script = try makeScript("lines.sh", "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\nexit 0\n")
        var lines: [String] = []
        for try await line in MacOSChestnutProcess(executableURL: script).stream([]) {
            lines.append(line)
        }
        XCTAssertEqual(lines, ["a", "b", "c"])
    }

    func testStreamYieldsFinalLineWithoutTrailingNewline() async throws {
        let script = try makeScript("partial.sh", "#!/bin/sh\nprintf 'tail-without-newline'\nexit 0\n")
        var lines: [String] = []
        for try await line in MacOSChestnutProcess(executableURL: script).stream([]) {
            lines.append(line)
        }
        XCTAssertEqual(lines, ["tail-without-newline"])
    }

    func testStreamNonZeroExitThrowsRejectedWithStderr() async throws {
        let script = try makeScript("bad.sh", "#!/bin/sh\necho first\necho diag >&2\nexit 1\n")
        var lines: [String] = []
        do {
            for try await line in MacOSChestnutProcess(executableURL: script).stream([]) {
                lines.append(line)
            }
            XCTFail("expected rejection")
        } catch let error as ChatError {
            guard case let .rejected(detail) = error else {
                return XCTFail("expected rejected, got \(error)")
            }
            XCTAssertEqual(lines, ["first"], "失败前已产出的行不丢")
            XCTAssertTrue(detail.contains("diag"))
        }
    }

    func testStreamStopIsCleanAndTeardown() async throws {
        let script = try makeScript("long.sh", "#!/bin/sh\nsleep 30\n")
        let process = MacOSChestnutProcess(executableURL: script)
        let stream = process.stream([])
        var iterator = stream.makeAsyncIterator()

        // 等进程确实启动后再 stop（避免竞态误测）
        try await Task.sleep(nanoseconds: 200_000_000)
        await process.stop()
        // 重复 stop：no-op、不崩
        await process.stop()

        var thrown: Error?
        do {
            while let _ = try await iterator.next() {}
        } catch {
            thrown = error
        }
        XCTAssertNil(thrown, "用户 stop 必须以正常结束收尾，不伪造失败")
    }
}
