/**
 * @module L6.Watchdog.StateMigration
 * @layer L6 进程边界（Watchdog 守护进程）
 *
 * Phase 1455 Step A: state 资源迁移协议 owner 原语
 * （root `watchdog-state.json` → `watchdog/state.json`）。
 *
 * 与 config 迁移（Phase 1289 Step B、config-migration-journal.ts）同型：
 *   intent → publish（owner mutation）→ outcome（回读验证后落盘）→ layout
 * 中断恢复：intent 存在而 outcome 不存在 = pending，由 findPending 发现、
 * CLIProcess 编排幂等续跑；迁移 id 由 legacy 原文 content-derived
 * （`watchdog-state-relocation-<sha256[0:12]>`），同输入重入收敛同一 journal。
 *
 * 与 config 迁移的语义差异（总览/Step A 拍板）：
 * - 迁移后稳态以 journal outcome(completed) 判定 already，不做内容比对
 *   （迁移后生产写只走新路径，legacy 冻结漂移）；
 * - state 是 JSON 原文整体搬迁（publish = verbatim copy），不做 schema 变换。
 *
 * Phase 1455 Step C：legacy 文件清退由编排层在迁移终态收口（outcome 回读
 * 验证后删 root watchdog-state.json；logs/watchdog.log 与
 * watchdog-subscriptions/ 由 legacy-retirement.ts 原语清退）。
 *
 * 本模块只提供原语、不编排（编排见 cli/watchdog-state-migration.ts）。
 * fs 一律以 chestnutRoot 为 baseDir；路径全部出自 ./layout.js。
 */
import type { FileSystem } from '../foundation/fs/index.js';
import {
  WATCHDOG_LAYOUT_SCHEMA_VERSION,
  WATCHDOG_LEGACY_PATHS,
  WATCHDOG_PATHS,
} from './layout.js';
import { publishWatchdogLayout } from './config-migration-journal.js';

export interface WatchdogStateMigrationIntent {
  schema_version: number;
  migration_id: string;
  kind: 'watchdog-state-relocation';
  /** ISO 8601 创建时间（诊断用，不参与幂等判定）。 */
  created_at: string;
  source: {
    /** legacy state 路径（chestnutRoot 相对，诊断用）。 */
    path: string;
    /** legacy state 原文 sha256 hex。 */
    sha256: string;
  };
}

export interface WatchdogStateMigrationOutcome {
  schema_version: number;
  migration_id: string;
  /**
   * completed: 新路径就位、回读验证通过；
   * conflict:  双方内容冲突、均保留（fail-loud 由编排层抛出）；
   * noop:      resume 时双方皆无、无事可做。
   */
  status: 'completed' | 'conflict' | 'noop';
  completed_at: string;
  /** 本次迁移是否实际写入了 watchdog/state.json（resume 补写为 false）。 */
  published: boolean;
  detail?: string;
}

export interface WatchdogStateMigrationJournal {
  intent?: WatchdogStateMigrationIntent;
  outcome?: WatchdogStateMigrationOutcome;
}

function migrationDir(migrationId: string): string {
  return `${WATCHDOG_PATHS.migrations}/${migrationId}`;
}

function readRawIfExists(fs: FileSystem, path: string): string | null {
  return fs.existsSync(path) ? fs.readSync(path) : null;
}

/** 读单个 state 迁移 journal；文件存在但 JSON 损坏 → throw（不静默）。 */
function readJournal(fs: FileSystem, migrationId: string): WatchdogStateMigrationJournal {
  const dir = migrationDir(migrationId);
  const journal: WatchdogStateMigrationJournal = {};
  const intentPath = `${dir}/intent.json`;
  const outcomePath = `${dir}/outcome.json`;
  if (fs.existsSync(intentPath)) {
    journal.intent = JSON.parse(fs.readSync(intentPath)) as WatchdogStateMigrationIntent;
  }
  if (fs.existsSync(outcomePath)) {
    journal.outcome = JSON.parse(fs.readSync(outcomePath)) as WatchdogStateMigrationOutcome;
  }
  return journal;
}

export function createWatchdogStateMigration(fs: FileSystem) {
  return {
    schemaVersion: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    statePath: WATCHDOG_PATHS.state,
    legacyPath: WATCHDOG_LEGACY_PATHS.state,

    /** 读新路径原文；不存在 → null。 */
    readNewRaw: (): string | null => readRawIfExists(fs, WATCHDOG_PATHS.state),
    /** 读 legacy 原文；不存在 → null。 */
    readLegacyRaw: (): string | null => readRawIfExists(fs, WATCHDOG_LEGACY_PATHS.state),

    /** owner mutation：legacy 原文 verbatim 发布到新路径（writeAtomicSync 自建父目录）。 */
    publish: (raw: string): void => {
      fs.writeAtomicSync(WATCHDOG_PATHS.state, raw);
    },

    /** 写 intent（first-write-wins）：已存在 → no-op。 */
    writeIntent: (intent: WatchdogStateMigrationIntent): void => {
      const p = `${migrationDir(intent.migration_id)}/intent.json`;
      if (fs.existsSync(p)) return;
      fs.writeAtomicSync(p, `${JSON.stringify(intent, null, 2)}\n`);
    },

    /** 写 outcome（允许覆盖：conflict 重判 / resume 补写同态终态）。 */
    writeOutcome: (outcome: WatchdogStateMigrationOutcome): void => {
      const p = `${migrationDir(outcome.migration_id)}/outcome.json`;
      fs.writeAtomicSync(p, `${JSON.stringify(outcome, null, 2)}\n`);
    },

    /** 读单个 state 迁移 journal；文件存在但 JSON 损坏 → throw（不静默）。 */
    readJournal: (migrationId: string): WatchdogStateMigrationJournal => readJournal(fs, migrationId),

    /**
     * 该迁移 id 是否已落 completed outcome（迁移后稳态 already 的判定依据——
     * legacy 清退归 Step C，期间双方并存属正常）。
     */
    hasCompleted: (migrationId: string): boolean => {
      return readJournal(fs, migrationId).outcome?.status === 'completed';
    },

    /**
     * 发现 pending state 迁移（intent 存在、outcome 缺失）。
     * 与 config 迁移共享 migrations/ 目录——必须按 kind 过滤，互不误认。
     */
    findPending: (): { migrationId: string; intent: WatchdogStateMigrationIntent } | undefined => {
      if (!fs.existsSync(WATCHDOG_PATHS.migrations)) return undefined;
      const entries = fs
        .listSync(WATCHDOG_PATHS.migrations, { includeDirs: true })
        .filter((e) => e.isDirectory)
        .map((e) => e.name)
        .sort();
      for (const name of entries) {
        const dir = migrationDir(name);
        const intentPath = `${dir}/intent.json`;
        const outcomePath = `${dir}/outcome.json`;
        if (!fs.existsSync(intentPath) || fs.existsSync(outcomePath)) continue;
        const intent = JSON.parse(fs.readSync(intentPath)) as WatchdogStateMigrationIntent;
        if (intent.kind !== 'watchdog-state-relocation') continue;
        return { migrationId: name, intent };
      }
      return undefined;
    },

    finalizeLayout: (): void => publishWatchdogLayout(fs),
  } as const;
}

export type WatchdogStateMigration = ReturnType<typeof createWatchdogStateMigration>;
