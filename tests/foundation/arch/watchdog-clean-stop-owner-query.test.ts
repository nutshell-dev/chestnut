/**
 * Phase 1878 Step E（watchdog-clean-stop-storage-bypass）：Watchdog 不再直读
 * clean-stop 文件字面量的 ratchet（扫描模式比照 watchdog-assembly-zero-edge）。
 *
 * 冻结 invariant：src/watchdog/** 零 `existsSync('clean-stop')` 形态的直读——
 * clean-stop 意图必须经 PM 稳定查询（hasCleanStopIntent）消费。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const WATCHDOG_DIR = path.join(SRC_ROOT, 'watchdog');

describe('phase 1878 Step E: Watchdog clean-stop 经 PM owner 查询冻结', () => {
  it("src/watchdog/** 零 existsSync('clean-stop') 字面直读", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(WATCHDOG_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/existsSync\(\s*['"]clean-stop['"]\s*\)/.test(text)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
