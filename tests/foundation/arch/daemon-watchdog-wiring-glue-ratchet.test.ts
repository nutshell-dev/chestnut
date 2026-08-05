import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 500: ratchet test baseline for daemon ↔ watchdog cross-module importers.
 *
 * 方向约束由更精确的可执行 ratchet 承担：
 *   - phase 1247 daemon-watchdog-dependency-direction-ratchet：Daemon → Watchdog = 0
 *   - phase 1284 daemon-entry-resolver-boundary：Watchdog → Daemon 仅经登记稳定
 *     子入口 daemon/entry-resolver.js（consumer 集合显式锁定）
 *
 * 历史：phase 456 lint rules 已于 phase 696 Step A 撤；phase 493 双向零 import
 * ratchet 因与 phase 1284 设计确认的 Watchdog → Daemon.entry-resolver 稳定单向边
 * 冲突，已于 phase 1284 Step C 退役（其两半分别由上两条更窄 ratchet 覆盖）。
 *
 * This test snapshots the wiring glue importers (CLI / assembly / wiring entries)
 * that legitimately deep-import the watchdog or daemon module.
 *
 * Adding new importers requires explicit acknowledgement by updating the baseline.
 */
describe('daemon-watchdog cross-module baseline ratchet (phase 500)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  function importerSet(grepPattern: string): Set<string> {
    const cmd = `grep -rEln "${grepPattern}" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    return new Set(
      out.trim().split('\n').filter(Boolean).map(f => path.relative(srcRoot, f)),
    );
  }

  it('watchdog deep importers from outside watchdog/ + daemon/ match baseline', () => {
    const all = importerSet(`from ['\\"][^'\\"]*watchdog/`);
    const fromOutside = [...all].filter(
      f => !f.startsWith('watchdog/') && !f.startsWith('daemon/'),
    ).sort();

    // baseline captured 2026-06-20 (main HEAD d3d8ff51 + phase 444 已合)
    // phase 552 update: 2 guidance composers (claw-inactivity / claw-crashed) 已迁 type import
    // 到 foundation/utils/claw-failure-classes、不再 import from watchdog/watchdog-utils。
    // phase 708 update: claw-failure-classes 迁 watchdog/、2 guidance composers 恢复 type-only import from watchdog。
    // phase 1289 Step B: watchdog config 迁移协议新增两处特许消费——Assembly config-load
    // （legacy root `watchdog:` 段 raw 读/删原语，永久保留以支持旧安装迁移）与 CLI
    // 同层编排模块 watchdog-config-migration；均为迁移协议组成，非 daemon/监督依赖。
    const expected = [
      'assembly/business-systems.ts',
      'assembly/config/compose-config.ts',
      'assembly/config/config-load.ts',
      'assembly/file-routing-aggregator.ts',
      // phase 1263 Step C / phase 1264 Step A: claw_crashed / claw_inactivity composer 原子迁为 typed binding
      // （仍 protocol-only import owner codec）
      'assembly/guidance/bindings/claw-crashed.ts',
      'assembly/guidance/bindings/claw-inactivity.ts',
      'cli/commands/claw-watch.ts',
      'cli/commands/init.ts',
      'cli/commands/status.ts',
      'cli/commands/stop.ts',
      'cli/commands/watchdog-cli.ts',
      'cli/index.ts',
      'cli/supervision-policy.ts',
      'cli/watchdog-config-migration.ts',
    ].sort();
    expect(fromOutside).toEqual(expected);
  });
});
