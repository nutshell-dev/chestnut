import { defineConfig } from 'vitest/config';
import os from 'node:os';

const maxThreads = os.cpus().length;

/**
 * phase 1231: vi.mock (file-level static) file 列表
 * 这些 file 不能跑 isolate:false (cross-file 模块串扰)
 * 维护: NEW test 用 vi.mock 需加此列表 (待 r+ lint check 防漂)
 *
 * 生成: grep -rln "^vi.mock\|vi\.mock(" tests/ | sort
 * 数量: 110 file
 */
const VI_MOCK_FILES = [
  'tests/assembly/assemble-dream-trigger-guard.test.ts',
  'tests/assembly/assemble-evolution-guard.test.ts',
  'tests/assembly/assemble-evolution-toolregistry.test.ts',
  'tests/assembly/assemble-lockfile-cleanup.test.ts',
  'tests/assembly/assemble.test.ts',
  'tests/assembly/detect-unclean-exit.test.ts',
  'tests/cli/already-running-sentinel.test.ts',
  'tests/cli/daemon-entry.test.ts',
  'tests/cli/chat-viewport-claw-manager-narrow.test.ts',
  'tests/cli/chat-viewport-stream-reader-start-fail.test.ts',
  'tests/cli/claw-send-confinement.test.ts',
  'tests/cli/commands/claw-health.test.ts',
  'tests/cli/commands/claw-list.test.ts',
  'tests/cli/commands/subagent-list.test.ts',
  'tests/cli/commands/subagent-steps-json.test.ts',
  'tests/cli/contract-events.test.ts',
  'tests/cli/contract.test.ts',
  'tests/cli/daemon-command.test.ts',
  'tests/cli/daemon-loop.test.ts',
  'tests/cli/init-envvar.test.ts',
  'tests/cli/motion-steps-action-error.test.ts',
  'tests/cli/password-restore-reverse.test.ts',
  'tests/cli/start.test.ts',
  'tests/cli/stop-orphan-cleanup-audit.test.ts',
  'tests/cli/watchdog.test.ts',
  'tests/core/async-task-system/cancel-pending-corrupt.test.ts',
  'tests/core/async-task-system/race-deadletter.test.ts',
  'tests/core/async-task-system/sent-marker-idempotency.test.ts',
  'tests/core/async-task-system/silent-catch.test.ts',
  'tests/core/async-task-system/task-recovery-corrupt.test.ts',
  'tests/core/async-task-system/task-recovery-phase989.test.ts',
  'tests/core/builtins-slow.test.ts',  // phase 1252: slow outlier split
  'tests/core/builtins.test.ts',
  'tests/core/contract-review-request.test.ts',
  'tests/core/contract/archive-race.test.ts',
  'tests/core/contract/audit-completed-single-emit.test.ts',
  'tests/core/contract/cancel-save-before-abort.test.ts',
  'tests/core/contract/cancel-signal-propagation.test.ts',
  'tests/core/contract/contract-system-close.test.ts',
  'tests/core/contract/lifecycle-orphan-lock.test.ts',
  'tests/core/contract/lifecycle-race.test.ts',
  'tests/core/contract/lock.test.ts',
  'tests/core/contract/pause-abort-verifier.test.ts',
  'tests/core/contract/verification.test.ts',
  'tests/core/contract/verifier-job-cancel-skip.test.ts',
  'tests/core/contract/verifier-job-signal-audit.test.ts',
  'tests/core/contract/verifier-job.test.ts',
  'tests/core/contract/verifier-robustness.test.ts',
  'tests/core/contract_manager.test.ts',
  'tests/core/contract_manager_llm.test.ts',
  'tests/core/evolution-system.test.ts',
  'tests/core/evolution-system/retro-scheduler.test.ts',
  'tests/core/evolution-system/state-corrupt.test.ts',
  'tests/core/evolution-system/state-file.test.ts',
  'tests/core/evolution-system/system-clawfs-factory.test.ts',
  'tests/core/evolution-system/system-contract-factory.test.ts',
  'tests/core/memory/system.test.ts',
  'tests/core/process_manager.test.ts',
  'tests/core/process_manager_spawn.test.ts',
  'tests/core/shadow-system/shadow-async.test.ts',
  'tests/core/shadow-system/shadow-signal-propagation.test.ts',
  'tests/core/shadow-system/shadow-tool.test.ts',
  'tests/core/spawn-system/spawn-signal-propagation.test.ts',
  'tests/core/spawn-system/sync-path.test.ts',
  'tests/core/subagent-executor.test.ts',
  'tests/core/subagent.test.ts',
  'tests/core/subagent/agent-audit-first.test.ts',
  'tests/core/subagent/agent-race-ghost.test.ts',
  'tests/core/subagent/subagent-tool-timeout-inherit.test.ts',
  'tests/daemon/daemon-loop-atomic-retry-state.test.ts',
  'tests/daemon/startup-check-atomic-write.test.ts',
  'tests/e2e/contract-motion-full-chain.test.ts',
  'tests/foundation/anthropic-cache.test.ts',
  'tests/foundation/audit/fallback-periodic-reconcile.test.ts',
  'tests/foundation/audit/writer-fallback-origin.test.ts',
  'tests/foundation/audit/writer-fallback.test.ts',
  'tests/foundation/file-watcher-persistent.test.ts',
  'tests/foundation/file-watcher.test.ts',
  'tests/foundation/fs.test.ts',
  'tests/foundation/llm-orchestrator/all-providers-context-exceeded-emit.test.ts',
  'tests/foundation/llm-orchestrator/hedge-post-first-chunk-failure.test.ts',
  'tests/foundation/llm-orchestrator/hedge-primary-success-race-lost.test.ts',
  'tests/foundation/llm-orchestrator/hedge-state-machine-cluster.test.ts',
  'tests/foundation/llm-orchestrator/hedge.test.ts',
  'tests/foundation/llm-orchestrator/merge-signals-cleanup.test.ts',
  'tests/foundation/llm-orchestrator/timeout-distinction.test.ts',
  'tests/foundation/llm-service.test.ts',
  'tests/foundation/llm.test.ts',
  'tests/foundation/messaging/inbox-reader-race.test.ts',
  'tests/foundation/process-exec/process-starttime-catch-filter.test.ts',
  'tests/foundation/process-manager/isready-stale-self-cleanup.test.ts',
  'tests/foundation/process-manager/ready-cleanup-narrow.test.ts',
  'tests/foundation/process-manager/ready-silent-x-narrow.test.ts',
  'tests/foundation/process-manager/ready-spawn-integration.test.ts',
  'tests/foundation/process-manager/ready-spawn-real-poll.test.ts',
  'tests/foundation/process-manager/ready-stale-cleanup-narrow.test.ts',
  'tests/foundation/process-manager/ready.test.ts',
  'tests/foundation/process-manager/spawn-duration-metric.test.ts',
  'tests/foundation/process-manager/spawn-fast-fail-child-died.test.ts',
  'tests/foundation/process-manager/spawn-race.test.ts',
  'tests/foundation/process-manager/spawn-remove-pid-audit.test.ts',
  'tests/foundation/process/stop-race.test.ts',
  'tests/foundation/snapshot/commit-throttle.test.ts',
  'tests/foundation/spawn-defaults.test.ts',
  'tests/foundation/stream-reader-race.test.ts',
  'tests/watchdog/handler-idempotent-install.test.ts',
  'tests/watchdog/watchdog-cron-dedup.test.ts',
  'tests/watchdog/watchdog-ever-spawned-crash.test.ts',
  'tests/watchdog/watchdog-pid-corrupt.test.ts',
  'tests/watchdog/watchdog-shutdown-guard.test.ts',
  'tests/watchdog/watchdog-state-narrow.test.ts',
  'tests/watchdog/watchdog-state-schema-version.test.ts',
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
 * phase 1231: 使用了 vi.* API (如 vi.fn, vi.waitFor) 但未显式 import { vi } 的文件
 * isolate:false 模式下 globals:true 不保证注入 vi 全局变量 / 需隔离跑
 * 发现方式: fast project 跑时 vi is not defined 失败 / 反向 audit
 */
const VI_GLOBALS_FILES = [
  'tests/cli/watchdog-utils.test.ts',
  'tests/core/dialog.test.ts',
  'tests/core/submit_subtask_tool.test.ts',
  'tests/core/tool-executor-ctx-prototype.test.ts',
  'tests/foundation/process-exec.test.ts',
];

const ISOLATED_FILES = [...VI_MOCK_FILES, ...VI_DOMOCK_FILES, ...VI_GLOBALS_FILES];

export default defineConfig({
  esbuild: {
    target: 'es2022', // phase 1218 γ kept / phase 1231 待评估是否 revert
  },
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'fast',
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ISOLATED_FILES,
          pool: 'threads',
          poolOptions: { threads: { maxThreads, isolate: false } },
          testTimeout: 15000,
          hookTimeout: 10000,
        },
      },
      {
        test: {
          name: 'isolated',
          globals: true,
          environment: 'node',
          include: ISOLATED_FILES,
          pool: 'threads',
          poolOptions: { threads: { maxThreads, isolate: true } },
          testTimeout: 15000,
          hookTimeout: 10000,
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
