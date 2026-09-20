/**
 * Phase 1878 Step D（watchdog-contract-sink-overassembly）：Watchdog 契约消费面
 * 收窄 ratchet（扫描模式比照 watchdog-assembly-zero-edge.test.ts）。
 *
 * 冻结 invariant：
 *  a) src/watchdog/** 零 `createContractSystem` / `createToolRegistry` 引用——
 *     Watchdog 不再为 execution-failure 交付构造完整 ContractSystem；
 *  b) src/watchdog/** 对 core/contract 的 import 仅限窄面符号
 *     （createExecutionFailureSink + ExecutionFailureSink 类型）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMPORT_SPECIFIER_RE, assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const WATCHDOG_DIR = path.join(SRC_ROOT, 'watchdog');

describe('phase 1878 Step D: Watchdog 契约窄 sink 消费面冻结', () => {
  it('src/watchdog/** 零 createContractSystem / createToolRegistry 引用', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(WATCHDOG_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('createContractSystem') || text.includes('createToolRegistry')) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/watchdog/** 对 core/contract 的 import 仅限窄 sink 面', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(WATCHDOG_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/import[^;]*from\s+['"]([^'"]*core\/contract[^'"]*)['"]/g)) {
        const statement = m[0];
        const symbols = statement.replace(/import\s+(type\s+)?\{/, '').replace(/\}\s*from[\s\S]*$/, '');
        const names = symbols.split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean);
        for (const name of names) {
          if (name !== 'createExecutionFailureSink' && name !== 'ExecutionFailureSink') {
            offenders.push(`${path.relative(SRC_ROOT, file)} (${name} from ${m[1]})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/watchdog/** 零 core/contract 深链 import（只走 barrel）', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(WATCHDOG_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
        if (/core\/contract\/(?!index\.js)/.test(m[1])) {
          offenders.push(`${path.relative(SRC_ROOT, file)} (${m[1]})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
