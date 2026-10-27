import Foundation
import LauncherCore

/// macOS Process 实现的 ChestnutProcess。只负责进程、stdout/stderr 和退出码；
/// 协议解释在 core。stdout 协议数据与 stderr 诊断分离；teardown 不泄漏子进程。
public final class MacOSChestnutProcess: SetupChestnutProcess, @unchecked Sendable {
    public let executableURL: URL

    private let lock = NSLock()
    private var runningProcess: Process?
    private var stopRequested = false

    public init(executableURL: URL) {
        self.executableURL = executableURL
    }

    /// @Sendable 回调共享的可变状态盒子（内部锁保护）。
    private final class IOState: @unchecked Sendable {
        let lock = NSLock()
        var buffer = Data()
        var errData = Data()
        var finished = false
    }

    /// 一次性运行：收集 stdout 行、stderr 全文与退出状态。环境默认继承。
    public func run(_ argv: [String]) async throws -> ProcessOutput {
        try await run(argv, stdin: nil)
    }

    public func run(_ argv: [String], stdin: String?) async throws -> ProcessOutput {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let stdout = Pipe()
            let stderr = Pipe()
            process.executableURL = executableURL
            process.arguments = argv
            process.standardOutput = stdout
            process.standardError = stderr
            let input = Pipe()
            if stdin != nil { process.standardInput = input }

            let state = IOState()
            stdout.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { return }
                state.lock.lock()
                state.buffer.append(chunk)
                state.lock.unlock()
            }
            stderr.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { return }
                state.lock.lock()
                state.errData.append(chunk)
                state.lock.unlock()
            }

            process.terminationHandler = { proc in
                stdout.fileHandleForReading.readabilityHandler = nil
                stderr.fileHandleForReading.readabilityHandler = nil
                // 进程已终止：读取管道残余数据直到 EOF
                state.lock.lock()
                state.buffer.append(stdout.fileHandleForReading.readDataToEndOfFile())
                state.errData.append(stderr.fileHandleForReading.readDataToEndOfFile())
                let outData = state.buffer
                let errData = state.errData
                state.lock.unlock()

                let outText = String(decoding: outData, as: UTF8.self)
                var lines = outText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
                if lines.last == "" { lines.removeLast() }
                let bySignal = proc.terminationReason == .uncaughtSignal
                let output = ProcessOutput(
                    stdoutLines: lines,
                    stderr: String(decoding: errData, as: UTF8.self),
                    exitCode: bySignal ? 0 : proc.terminationStatus,
                    terminationSignal: bySignal ? proc.terminationStatus : nil
                )
                continuation.resume(returning: output)
            }

            do {
                try process.run()
                if let stdin {
                    input.fileHandleForWriting.write(Data(stdin.utf8))
                    try? input.fileHandleForWriting.close()
                }
            } catch {
                stdout.fileHandleForReading.readabilityHandler = nil
                stderr.fileHandleForReading.readabilityHandler = nil
                continuation.resume(throwing: ChatError.transport(detail: "launch failed: \(error.localizedDescription)"))
            }
        }
    }

    /// 长驻运行：逐行产出 stdout。exit 0 / 用户 stop 正常结束；非零退出或信号以 ChatError 结束。
    public func stream(_ argv: [String]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let process = Process()
            let stdout = Pipe()
            let stderr = Pipe()
            process.executableURL = executableURL
            process.arguments = argv
            process.standardOutput = stdout
            process.standardError = stderr

            lock.lock()
            stopRequested = false
            runningProcess = process
            lock.unlock()

            let state = IOState()
            let finishOnce: (Error?) -> Void = { error in
                state.lock.lock()
                defer { state.lock.unlock() }
                guard !state.finished else { return }
                state.finished = true
                if let error {
                    continuation.finish(throwing: error)
                } else {
                    continuation.finish()
                }
            }

            stdout.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { return }
                state.lock.lock()
                state.buffer.append(chunk)
                var lines: [String] = []
                while let newline = state.buffer.firstIndex(of: 0x0A) {
                    let lineData = state.buffer.subdata(in: state.buffer.startIndex..<newline)
                    state.buffer.removeSubrange(state.buffer.startIndex...newline)
                    lines.append(String(decoding: lineData, as: UTF8.self))
                }
                state.lock.unlock()
                for line in lines { continuation.yield(line) }
            }
            stderr.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { return }
                state.lock.lock()
                state.errData.append(chunk)
                state.lock.unlock()
            }

            process.terminationHandler = { [self] proc in
                stdout.fileHandleForReading.readabilityHandler = nil
                stderr.fileHandleForReading.readabilityHandler = nil
                state.lock.lock()
                state.buffer.append(stdout.fileHandleForReading.readDataToEndOfFile())
                state.errData.append(stderr.fileHandleForReading.readDataToEndOfFile())
                let rest = state.buffer
                state.buffer = Data()
                let errText = String(decoding: state.errData, as: UTF8.self)
                state.lock.unlock()
                if !rest.isEmpty {
                    // 与 readabilityHandler 同规则按行分割（readabilityHandler 与 termination
                    // 存在消费竞争：termination 路径读走的残余可能含换行，不能整块当一行交付）；
                    // 最后无换行的残余仍作为一行交付。
                    var remainder = rest
                    while let newline = remainder.firstIndex(of: 0x0A) {
                        continuation.yield(String(decoding: remainder.subdata(in: remainder.startIndex..<newline), as: UTF8.self))
                        remainder.removeSubrange(remainder.startIndex...newline)
                    }
                    if !remainder.isEmpty {
                        continuation.yield(String(decoding: remainder, as: UTF8.self))
                    }
                }

                lock.lock()
                let stopped = stopRequested
                if runningProcess === proc { runningProcess = nil }
                lock.unlock()

                if stopped {
                    finishOnce(nil)
                } else if proc.terminationReason == .exit && proc.terminationStatus == 0 {
                    finishOnce(nil)
                } else {
                    let detail = errText.trimmingCharacters(in: .whitespacesAndNewlines)
                    finishOnce(ChatError.rejected(
                        detail: detail.isEmpty ? "stream exited \(proc.terminationStatus)" : detail
                    ))
                }
            }

            do {
                try process.run()
            } catch {
                lock.lock()
                if runningProcess === process { runningProcess = nil }
                lock.unlock()
                finishOnce(ChatError.transport(detail: "launch failed: \(error.localizedDescription)"))
            }

            continuation.onTermination = { @Sendable _ in
                // consumer 取消也 teardown，防止子进程泄漏
                self.lock.lock()
                let proc = self.runningProcess
                self.lock.unlock()
                if let proc, proc.isRunning { proc.terminate() }
            }
        }
    }

    /// single-flight 停止：无运行中进程时 no-op；SIGTERM 后最多等 2s，再 SIGKILL。
    public func stop() async {
        let proc = lock.withLock { () -> Process? in
            stopRequested = true
            return runningProcess
        }
        guard let proc, proc.isRunning else { return }
        proc.terminate()
        let deadline = Date().addingTimeInterval(2)
        while proc.isRunning && Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        if proc.isRunning {
            kill(proc.processIdentifier, SIGKILL)
        }
    }
}
