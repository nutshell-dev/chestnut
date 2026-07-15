import { defineConfig } from 'vitest/config';
import os from 'node:os';

// phase 323: 多 worktree 并行测试 contention 防护
// env unset → fallback os.cpus() (单 worktree 跑等价旧行为)
// env 设有效正整数 → vitest worker 上限取 env 值
// 详 design/practices.md "多 worktree 并行跑测试" 段
const envMaxThreads = parseInt(process.env.VITEST_MAX_THREADS ?? '', 10);
const maxThreads = Number.isFinite(envMaxThreads) && envMaxThreads > 0
  ? envMaxThreads
  : os.cpus().length;

/**
 * phase 1231: vi.mock (file-level static) file 列表
 * 这些 file 不能跑 isolate:false (cross-file 模块串扰)
 * 维护: NEW test 用 vi.mock 需加此列表
 *
 * 生成: find tests -name "*.test.ts" -exec grep -lE "^vi\.mock\(|^\s*vi\.mock\(" {} \; | sort
 * 数量: 111 file (sync 2026-07-14 / phase 1023 碎片合并: -26 +10)
 * Invariant test: tests/design/vi-mock-list-consistency-invariant.test.ts 守 list ↔ 真 use site 一致性
 *   (phase 316 V53 a 真治、撤回 phase 306 ratify「推 §10」、详 `coding plan/phase316/`)
 */
const VI_MOCK_FILES = [
  // phase 121: 5 assembly tests moved out of ISOLATED
  // SkillSystem vi.mock removed via AssembleDeps DI; remaining vi.mock
  // (ContractSystem / AsyncTaskSystem / Messaging) do not cause cross-file
  // module registry race in 5x consecutive fast-project runs.
  // 'tests/assembly/assemble-dream-trigger-guard.test.ts',
  // 'tests/assembly/assemble-evolution-guard.test.ts',
  // 'tests/assembly/assemble-evolution-toolregistry.test.ts',
  // 'tests/assembly/assemble-lockfile-cleanup.test.ts',
  // 'tests/assembly/assemble.test.ts',
  'tests/assembly/detect-unclean-exit.test.ts',
  // phase 1421: tests/cli/already-running-sentinel.test.ts moved to fast project
  // — daemon command bodies extracted with DI seam; tests no longer need vi.mock.
  'tests/core/agent-executor/maxsteps-default.test.ts',  // phase 221: vi.mock DEFAULT_MAX_STEPS → 5 (was 23s/run)
  'tests/cli/audit-info.test.ts',
  'tests/cli/audit-query.test.ts',
  'tests/cli/daemon-handlers.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — tests no longer need vi.mock for process-exec isAlive.
  // 'tests/cli/chat-viewport-claw-manager-narrow.test.ts',
  'tests/cli/chat-viewport-stream-reader-start-fail.test.ts',
  // phase 102 (SHA fb9764d0): LockContext + VerificationContext DI 替 vi.mock pattern。
  // 'tests/core/contract/lock-retry-jitter.test.ts',
  'tests/cli/claw-send-confinement.test.ts',
  'tests/cli/commands/claw-health.test.ts',
  'tests/cli/commands/claw-list.test.ts',
  'tests/cli/commands/claw-stream.test.ts',
  'tests/cli/commands/status.test.ts',

  'tests/cli/commands/subagent-cli-output.test.ts',  // phase 1395 merged from subagent-list + subagent-steps-json
  'tests/cli/config-provider-add-probe.test.ts',  // phase 451 Step A
  'tests/cli/config-provider-set-primary-probe.test.ts',  // phase 451 Step A
  'tests/cli/contract-events.test.ts',
  'tests/cli/contract.test.ts',
  'tests/cli/daemon-command.test.ts',
  'tests/cli/daemon-loop.test.ts',
  'tests/cli/init-envvar.test.ts',
  'tests/cli/motion-steps-action-error.test.ts',
  'tests/cli/password-restore-reverse.test.ts',
  'tests/cli/start.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — tests no longer need vi.mock for process-exec isAlive.
  // 'tests/cli/stop-orphan-cleanup-audit.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext.
  // 'tests/cli/watchdog.test.ts',
  // phase 1023: cancel-pending-corrupt 等 5 文件合并入 cancel-invariants；
  // task-recovery-phase872/874/875/904/989 合并入 task-recovery-invariants；
  // phase879/881/882 合并入 phase-messaging-invariants；
  // phase883/884/885/905 合并入 dispatch-resilience-invariants；
  // phase886/887/889/902 合并入 migration-recovery-invariants
  'tests/core/async-task-system/cancel-invariants.test.ts',  // vi.mock file-watcher
  'tests/core/async-task-system/task-recovery-invariants.test.ts',  // vi.mock result-delivery + process-exec
  'tests/core/async-task-system/phase-messaging-invariants.test.ts',  // vi.mock messaging
  'tests/core/async-task-system/dispatch-resilience-invariants.test.ts',  // vi.mock result-delivery
  'tests/core/async-task-system/migration-recovery-invariants.test.ts',  // vi.mock result-delivery
  'tests/core/async-task-system/race-deadletter.test.ts',
  'tests/core/async-task-system/sent-marker-idempotency.test.ts',
  'tests/core/async-task-system/silent-catch.test.ts',
  'tests/core/async-task-system/task-recovery-corrupt.test.ts',
  'tests/core/async-task-system/phase906.test.ts',  // phase 906: vi.mock result-delivery
  // phase 1352 reverted (post-merge fix): spawn tool extraction conflicted with phase 1332
  // builtins.test.ts now has vi.hoisted only (mockSchedule) → stays in fast project
  // phase 1353: builtins-slow.test.ts moved to fast (dead vi.mock removed)
  // phase 118 (SHA <TBD>): EvolutionSystemDeps DI 复用替 vi.mock skill-system pattern
  // 'tests/core/contract-review-request.test.ts',
  // phase 1023: archive-race/audit-completed-single-emit/cancel-save-before-abort 等
  // 10 文件合并入 archive/boot/dispose/lifecycle/lock-invariants
  'tests/core/contract/archive-invariants.test.ts',  // vi.mock constants
  'tests/core/contract/boot-invariants.test.ts',  // vi.mock constants
  'tests/core/contract/dispose-invariants.test.ts',  // vi.mock constants + verifier-job
  'tests/core/contract/lifecycle-invariants.test.ts',  // vi.mock constants
  'tests/core/contract/lock-invariants.test.ts',  // vi.mock constants (5/100)
  // phase 87: verifier-job DI 替 vi.mock pattern、2 测试不需 module registry isolation、移 fast project。
  // 'tests/core/contract/cancel-signal-propagation.test.ts',
  // 'tests/core/contract/contract-system-close.test.ts',
  'tests/core/contract/lock.test.ts',
  'tests/core/event-loop/event-loop.test.ts',  // phase 783: vi.mock constants (LLM retry delay)
  // phase 102 (SHA fb9764d0): LockContext + VerificationContext DI 替 vi.mock pattern。
  // 'tests/core/contract/verification.test.ts',
  // phase 91: verifier-job VerifierRuntimeConfig 加 runSubagent? DI 替 vi.mock pattern、
  // 4 测试不需 module registry isolation、移 fast project。
  // 'tests/core/contract/verifier-job-cancel-skip.test.ts',
  // 'tests/core/contract/verifier-job-signal-audit.test.ts',
  // 'tests/core/contract/verifier-job.test.ts',
  // 'tests/core/contract/verifier-robustness.test.ts',
  // phase 1351: contract_manager.test.ts moved out (LOCK tests extracted to contract_manager-locks.test.ts)
  // phase 1338 split: sister fire-and-forget extracted; fire-and-forget tests
  // drive async verification pipeline (completeSubtask → fire-and-forget chain
  // → status update), waitFor polls async transitions.
  // phase 82 Op G: 移出 ISOLATED — phase 80 manager.getProgress ENOENT retry
  // (87cb9844) 治 active→archive TOCTOU 后 race 减少；file header L5「fast
  // project / no vi.mock」注释 + phase 1465 mutex instance-bound 共指本 file
  // 可 fast。若再触 flake、回 ISOLATED。
  // 'tests/core/contract_manager-fire-and-forget.test.ts',
  'tests/core/contract_manager-locks.test.ts',
  // phase 94 (SHA <Step B 合 main>): ContractSystem 加 runSubagent? DI 透传到
  // VerifierConfig（与 phase 87 + 91 形成 3 层 carrier 链）、本测试不需 module
  // registry isolation、移 fast project。subagent vi.mock 9× cluster 收官。
  // 'tests/core/contract_manager_llm.test.ts',
  // phase 116: EvolutionSystemDeps createSkillSystem? DI
  // 'tests/core/evolution-system.test.ts',
  // phase 114: RetroConfig DI 替 vi.mock skill-system pattern。
  // 'tests/core/evolution-system/retro-scheduler.test.ts',
  // 'tests/core/evolution-system/state-corrupt.test.ts',
  // 'tests/core/evolution-system/state-file.test.ts',
  // phase 82 Op H: 移出 ISOLATED — 仅用 vi.hoisted + vi.fn instance injection、
  // 无 module-level vi.mock、不引 cross-file 模块串扰
  // 'tests/core/evolution-system/system-clawfs-factory.test.ts',
  // 'tests/core/evolution-system/system-contract-factory.test.ts',
  'tests/core/memory/system.test.ts',
  'tests/core/process_manager.test.ts',
  'tests/core/process_manager_spawn.test.ts',
  // phase 88 (SHA 91b0b934): spawn-system createSpawnTool DI replaced vi.mock
  // pattern, 2 tests don't need module registry isolation, moved to fast project.
  // 'tests/core/spawn-system/spawn-signal-propagation.test.ts',
  // 'tests/core/spawn-system/sync-path.test.ts',
  // phase 89 (SHA 4b905c15): shadow-system runSubagent DI replaced vi.mock
  // pattern, 3 tests don't need module registry isolation, moved to fast project.
  // 'tests/core/shadow-system/shadow-async.test.ts',
  // 'tests/core/shadow-system/shadow-signal-propagation.test.ts',
  // 'tests/core/shadow-system/shadow-tool.test.ts',
  // phase 93 (SHA 6dee52a4): subagent-executor ExecuteSubAgentTaskDeps
  // 加 runSubagent? DI 替 vi.mock pattern、本测试不需 module registry isolation、
  // 移 fast project。
  // 'tests/core/subagent-executor.test.ts',
  'tests/core/subagent.test.ts',
  'tests/core/subagent/agent-audit-first.test.ts',
  'tests/core/subagent/agent-race-ghost.test.ts',
  'tests/core/subagent/subagent-tool-timeout-inherit.test.ts',
  'tests/daemon/daemon-loop-atomic-retry-state.test.ts',
  'tests/daemon/startup-check-atomic-write.test.ts',
  'tests/foundation/anthropic-cache.test.ts',
  'tests/foundation/audit/fallback-periodic-reconcile.test.ts',
  'tests/foundation/audit/writer-fallback-origin.test.ts',
  'tests/foundation/audit/writer-fallback.test.ts',
  'tests/foundation/fs.test.ts',
  'tests/foundation/llm-orchestrator/hedge-cleanup-invariants.test.ts',
  'tests/foundation/llm-orchestrator/hedge-primary-success-race-lost.test.ts',
  'tests/foundation/llm-orchestrator/hedge-state-machine-cluster.test.ts',
  'tests/foundation/llm-orchestrator/hedge.test.ts',
  'tests/foundation/llm-orchestrator/orchestrator-misc-invariants.test.ts',
  'tests/foundation/llm-orchestrator/orchestrator.test.ts',  // phase 896: vi.mock anthropic adapter
  'tests/foundation/llm-service.test.ts',
  'tests/foundation/llm.test.ts',
  'tests/foundation/llm-provider/anthropic-adapter.test.ts',  // phase 862: vi.mock @anthropic-ai/sdk
  'tests/foundation/messaging/inbox-reader-race.test.ts',
  'tests/foundation/messaging/outbox-reader-reconcile.test.ts',  // phase 908: vi.mock process-exec isAlive
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — no longer needs module registry isolation.
  // 'tests/foundation/process-manager/isready-stale-self-cleanup.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — no longer needs module registry isolation.
  // 'tests/foundation/process-manager/ready-cleanup-narrow.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — no longer needs module registry isolation.
  // 'tests/foundation/process-manager/ready-silent-x-narrow.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext.
  // 'tests/foundation/process-manager/ready-spawn-integration.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext.
  // 'tests/foundation/process-manager/ready-spawn-real-poll.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — no longer needs module registry isolation.
  // 'tests/foundation/process-manager/ready-stale-cleanup-narrow.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — no longer needs module registry isolation.
  // 'tests/foundation/process-manager/ready.test.ts',
  'tests/foundation/process-manager/ready-invariants.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — spawnDetached mock remains but isAlive vi.mock removed.
  // 'tests/foundation/process-manager/spawn-duration-metric.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — spawnDetached mock remains but isAlive vi.mock removed.
  // 'tests/foundation/process-manager/spawn-fast-fail-child-died.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — spawnDetached mock remains but isAlive vi.mock removed.
  // 'tests/foundation/process-manager/spawn-race.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — spawnDetached mock remains but isAlive vi.mock removed.
  // 'tests/foundation/process-manager/spawn-remove-pid-audit.test.ts',
  // phase 99 (SHA df8f4558): l1IsAlive DI injected via ProcessManagerContext — kill mock remains but isAlive vi.mock removed.
  // 'tests/foundation/process/stop-race.test.ts',
  // phase 83 (SHA 5a4ca7a9): _stateMap module-level singleton
  // 已解散为 Snapshot instance private state (ML#3 治)，cross-reassemble 走
  // disk persist 唯一路径。snapshot 4 file 移出 ISOLATED。注释保留作历史。
  // 'tests/foundation/snapshot.test.ts',
  // 'tests/foundation/snapshot/cleanup-race-cluster.test.ts',
  // 'tests/foundation/snapshot/commit-throttle.test.ts',
  // 'tests/foundation/snapshot/consecutive-failures-singleton.test.ts',
  // phase 86 (SHA bdd329e3): createPendingWatcher 加 createWatcher
  // factory dep + task.test.ts 注入 mock watcher 同步派发 add-event，消除
  // OS-bound chokidar event 5000ms 超风险。task.test.ts 改归 fast project。
  // 注释保留作历史 + 回滚锚。
  // 'tests/core/task.test.ts',
  'tests/foundation/process-manager/stop.test.ts',
  'tests/foundation/spawn-defaults.test.ts',
  'tests/foundation/stream-reader-race.test.ts',
  'tests/foundation/unix-socket.test.ts',
  'tests/watchdog/handler-idempotent-install.test.ts',
  'tests/watchdog/watchdog-cron-dedup.test.ts',
  'tests/watchdog/watchdog-ever-spawned-crash.test.ts',
  'tests/watchdog/watchdog-pid-corrupt.test.ts',
  'tests/watchdog/watchdog-shutdown-guard.test.ts',
  'tests/watchdog/watchdog-state-narrow.test.ts',
  'tests/watchdog/watchdog-state-schema-version.test.ts',
  // phase 288 Step C sync: 48 entries added per find -name '*.test.ts' -exec grep 'vi.mock(' {} \;
  'tests/assembly/assemble-dream-trigger-guard.test.ts',
  'tests/assembly/assemble-evolution-guard.test.ts',
  'tests/assembly/assemble-evolution-toolregistry.test.ts',
  'tests/assembly/assemble-lockfile-cleanup.test.ts',
  'tests/assembly/assemble.test.ts',
  'tests/cli/audit-lookup.test.ts',
  'tests/cli/audit-motion-aware.test.ts',
  'tests/cli/audit-query-zero-result-hint.test.ts',
  'tests/cli/claw-send-status-hint.test.ts',
  'tests/cli/commands/claw-ls.test.ts',
  'tests/cli/commands/claw-status.test.ts',
  'tests/cli/commands/claw-trace-numbering.test.ts',
  'tests/cli/cross-cli-id-consistency.test.ts',
  'tests/cli/init-probe.test.ts',
  'tests/cli/steps-hint-invariant.test.ts',
  'tests/cli/stop-orphan-cleanup-audit.test.ts',
  'tests/cli/stop-orphan-watchdog-sweep.test.ts',
  'tests/cli/watchdog.test.ts',
  'tests/core/contract_manager_llm.test.ts',
  'tests/core/subagent/agent-tool-call-input-audit.test.ts',
  'tests/daemon/interrupt-watcher.test.ts',
  'tests/daemon/idempotent-signal-handlers.test.ts',
  'tests/foundation/audit/fallback-drop-observability.test.ts',
  'tests/foundation/audit/multi-file-concurrent-write.test.ts',
  'tests/watchdog/audit-wired-in-cli.test.ts',
  'tests/watchdog/ensure-singleton-lock.test.ts',
  'tests/watchdog/foreign-workspace-fail-loud.test.ts',
  'tests/watchdog/notify-dedup-persist.test.ts',
  'tests/watchdog/orphan-sweep.test.ts',
  'tests/watchdog/watchdog-a8-final-audit.test.ts',
  'tests/watchdog/watchdog-claws-dir-list-failed-audit.test.ts',
  'tests/watchdog/watchdog-cron-map-cleanup-no-claws-dir.test.ts',
  'tests/watchdog/watchdog-cron-skip-audit.test.ts',
  'tests/watchdog/watchdog-cli-stop-pid-missing.test.ts',
];

/**
 * phase 1231: vi.doMock + vi.resetModules file 列表 (2 file)
 * 注: writer-fallback.test.ts 同时也在 VI_MOCK_FILES 中 (含 vi.mock + vi.doMock)
 *    归 isolated project 无影响 (ISOLATED_FILES 数组展开后重复 include  harmless)
 */
const VI_DOMOCK_FILES = [
  'tests/foundation/audit/writer-fallback.test.ts',
];

/**
 * phase 1346: VI_GLOBALS_FILES list 全清空 — all files import vi explicitly from 'vitest'
 * phase 1231 立此 list 的原因 (vi.* without import) 已不存在 / 该 list 现 obsolete
 * 5 file 全移 fast project: watchdog-utils + dialog + submit_subtask_tool + tool-executor-ctx-prototype + (phase 1344) process-exec
 */
const VI_GLOBALS_FILES: string[] = [];

/**
 * phase 1006 Step B: OS-integration tests that need real process/spawn/ps/pgrep.
 * These run in a dedicated vitest project with isolate:true and limited concurrency.
 */
const INTEGRATION_PROCESS_FILES = [
  // phase 1011: root file is not matched by **/*.test.ts
  'tests/foundation/process-exec.test.ts',
  'tests/foundation/process-exec/**/*.test.ts',
  'tests/foundation/process/**/*.test.ts',
  'tests/foundation/process-manager/*spawn*.test.ts',
  'tests/foundation/process-manager/ready-spawn*.test.ts',
  'tests/cli/daemon.test.ts',
  'tests/cli/already-running-sentinel.test.ts',
  'tests/core/async-task-system/migrated-exec.test.ts',
];

/**
 * phase 1006 Step B: OS-integration tests that need real sockets/watcher/file events.
 */
const INTEGRATION_IO_FILES = [
  // phase 1011: real watcher files
  'tests/daemon/daemon-loop.test.ts',
  'tests/foundation/file-watcher/fallback-escalation.test.ts',
  'tests/foundation/stream-reader.test.ts',
  'tests/foundation/stream-reader-robustness.test.ts',
  'tests/e2e/chat-viewport-subscribe.test.ts',
  'tests/e2e/chat-viewport-regression.test.ts',
  'tests/e2e/chat-viewport-regression-slow.test.ts',
  'tests/e2e/contract-motion-full-chain.test.ts',
  'tests/foundation/process-manager/ready.test.ts',
  // socket
  'tests/foundation/transport.test.ts',
  // watcher / symlink
  'tests/foundation/file-watcher*.test.ts',
  'tests/foundation/file-watcher/**/*.test.ts',
  'tests/foundation/fs/node-fs-symlink*.test.ts',
];

/**
 * phase 1006 Step C: recursive vitest spawn integration test — manual/CI preflight only.
 */
const INFRA_FILES = [
  'tests/utils/run-root-teardown-integration.test.ts',
];

const ISOLATED_FILES = [...VI_MOCK_FILES, ...VI_DOMOCK_FILES, ...VI_GLOBALS_FILES];

export default defineConfig({
  /**
   * phase 1367: cacheDir 落 worktree-local
   * 默认 'node_modules/.vite' 跨 worktree 共享 (node_modules symlink to bare repo)
   * → 多 worktree 并行跑 vitest 时 results.json / transform cache race / ordering 错乱
   * 落 worktree CWD 后每 worktree 独立 / .gitignore 加 .vitest-cache/
   */
  cacheDir: '.vitest-cache',
  esbuild: {
    target: 'es2022', // phase 1218 γ kept / phase 1231 待评估是否 revert
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['.config/vitest-setup.ts'],
    // phase 245: ensure dist/cli.js exists before CLI smoke tests spawn it as a subprocess.
    globalSetup: ['.config/vitest-global-setup.ts'],
    // phase 22: clawspace 副本（.chestnut/claws/*/clawspace/.../tests/**）
    // 被 vitest 当 CLI filter 收集进 runner，因路径深度差 import 失败、
    // 触发 hook 超时。leading `**/` 让 exclude 在任意路径深度匹配 `.chestnut`
    // 节、与 project-level exclude 双保险。
    exclude: ['**/.chestnut/**', '**/node_modules/**', '**/dist/**'],
    projects: [
      {
        test: {
          name: 'fast',
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: [
            ...ISOLATED_FILES,
            ...INTEGRATION_PROCESS_FILES,
            ...INTEGRATION_IO_FILES,
            ...INFRA_FILES,
            '**/.chestnut/**',
            '**/node_modules/**',
            '**/dist/**',
          ],
          pool: 'threads',
          poolOptions: { threads: { maxThreads, isolate: false } },
          testTimeout: 15000,
          hookTimeout: 10000,
          teardownTimeout: 5000, // phase 781: force worker teardown after 5s to prevent orphan vitest processes
          maxConcurrency: 20, // phase 300: lift default 5 → 20 for describe.concurrent blocks
        },
      },
      {
        test: {
          name: 'isolated',
          globals: true,
          environment: 'node',
          include: ISOLATED_FILES,
          exclude: [
            '**/.chestnut/**',
            '**/node_modules/**',
            '**/dist/**',
            // phase 375: daemon-entry shim 已抽至 daemon-handlers.ts；原 daemon-entry.test.ts
            // 随之 rename 为 daemon-handlers.test.ts 并移出 exclude（新测试不再拉 assembly graph，
            // wall <2s）。保留 already-running-sentinel 在 fast project 运行。
            'tests/cli/already-running-sentinel.test.ts',
          ],
          pool: 'threads',
          poolOptions: { threads: { maxThreads, isolate: true } },
          testTimeout: 15000,
          hookTimeout: 10000,
          teardownTimeout: 5000, // phase 781: force worker teardown after 5s to prevent orphan vitest processes
        },
      },
      {
        test: {
          name: 'integration-process',
          globals: true,
          environment: 'node',
          include: INTEGRATION_PROCESS_FILES,
          exclude: ['**/.chestnut/**', '**/node_modules/**', '**/dist/**'],
          pool: 'threads',
          poolOptions: { threads: { maxThreads: 2, isolate: true } },
          testTimeout: 30000,
          hookTimeout: 15000,
          teardownTimeout: 5000,
        },
      },
      {
        test: {
          name: 'integration-io',
          globals: true,
          environment: 'node',
          include: INTEGRATION_IO_FILES,
          exclude: ['**/.chestnut/**', '**/node_modules/**', '**/dist/**'],
          pool: 'threads',
          poolOptions: { threads: { maxThreads: 2, isolate: true } },
          testTimeout: 15000,
          hookTimeout: 10000,
          teardownTimeout: 5000,
        },
      },
      {
        test: {
          name: 'infra',
          globals: true,
          environment: 'node',
          include: INFRA_FILES,
          exclude: ['**/.chestnut/**', '**/node_modules/**', '**/dist/**'],
          pool: 'threads',
          poolOptions: { threads: { maxThreads: 1, isolate: true } },
          testTimeout: 60000,
          hookTimeout: 30000,
          teardownTimeout: 10000,
        },
      },
    ],
    // phase 1223: server.deps.inline ['chokidar'] reverted - 实测 transform 3x 反优化
    // chokidar 是 native+JS heavy package / inline 强制每 worker re-bundle / 不复用 cached require
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.ts'
      ]
    }
  },
});

// phase 1006: export project file lists for invariant tests
export { INTEGRATION_PROCESS_FILES, INTEGRATION_IO_FILES, INFRA_FILES };
