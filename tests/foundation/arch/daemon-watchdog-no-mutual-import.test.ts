import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 493: ratchet test 防 daemon ↔ watchdog 模块互依回归。
 *
 * 期望状态（phase 444 闭环）：
 *   - src/daemon/* 0 import src/watchdog/*
 *   - src/watchdog/* 0 import src/daemon/*
 *   - wiring glue (daemon-entry.ts + watchdog-entry.ts + cli/index.ts) 可
 *     import 对方模块（M#5 模块单向：装配胶水承担 cross-module DI）。
 *
 * 与 phase 456 lint rules (no-daemon-to-watchdog + no-watchdog-to-daemon)
 * 双重保护。
 */
describe('daemon ↔ watchdog no mutual module import ratchet (phase 493)', () => {
  it('src/daemon/* contains 0 imports of src/watchdog/*', () => {
    const srcDaemonRoot = path.join(__dirname, '..', '..', '..', 'src', 'daemon');
    const cmd = `grep -rEn "from ['\\\"][^'\\\"]*watchdog/" ${srcDaemonRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });

  it('src/watchdog/* contains 0 imports of src/daemon/*', () => {
    const srcWatchdogRoot = path.join(__dirname, '..', '..', '..', 'src', 'watchdog');
    const cmd = `grep -rEn "from ['\\\"][^'\\\"]*daemon/" ${srcWatchdogRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});
