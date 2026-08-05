/**
 * Phase 1289 Step D: Watchdog → Assembly 零边冻结 ratchet。
 * （比照 watchdog-layout-boundary.test.ts 扫描模式 / Phase 1287 Step C）
 *
 * 冻结单一 invariant：Watchdog 配置 SoT 已迁自家 store（.chestnut/watchdog/config.yaml），
 * Watchdog production 与 root global config 之间不再存在依赖边：
 *  a) src/watchdog/** 所有 .ts 文件零 `assembly/` import specifier（含 type import）；
 *  b) src/watchdog/** 不得定义/引用旧 Assembly 配置入口符号 getGlobalConfig；
 *  c) compose-config.ts 不得再引用 watchdogConfigSchema / watchdog schema 字段；
 *  d) init.ts 不得再写 root YAML `watchdog:` 块 / log_archive_days。
 *
 * legacy 段读取只允许迁移编排的 raw 入口（Assembly config-load.ts 原语 +
 * CLI watchdog-config-migration），由 daemon-watchdog-wiring-glue-ratchet 白名单
 * 单独冻结，不在本 invariant 范围。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMPORT_SPECIFIER_RE, assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const WATCHDOG_DIR = path.join(SRC_ROOT, 'watchdog');
const COMPOSE_CONFIG = path.join(SRC_ROOT, 'assembly', 'config', 'compose-config.ts');
const INIT_COMMAND = path.join(SRC_ROOT, 'cli', 'commands', 'init.ts');

/** 收集 dir 下所有 .ts 文件的 import/export specifier（含 type import）。 */
function collectSpecifiers(dir: string): Array<{ file: string; specifier: string }> {
  const out: Array<{ file: string; specifier: string }> = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
      out.push({ file: path.relative(SRC_ROOT, file), specifier: m[1] });
    }
  }
  return out;
}

describe('phase 1289 Step D: Watchdog → Assembly 零边冻结', () => {
  it('src/watchdog/** 零 assembly/ import specifier（含 type import）', () => {
    const offenders = collectSpecifiers(WATCHDOG_DIR)
      .filter((i) => i.specifier.includes('assembly/'))
      .map((i) => `${i.file} (${i.specifier})`);
    expect(offenders).toEqual([]);
  });

  it('src/watchdog/** 不得定义或引用旧 Assembly 配置入口 getGlobalConfig', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(WATCHDOG_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('getGlobalConfig')) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('compose-config.ts 不得引用 watchdogConfigSchema / watchdog schema 字段', () => {
    const text = fs.readFileSync(COMPOSE_CONFIG, 'utf8');
    expect(text.includes('watchdogConfigSchema')).toBe(false);
    expect(/^\s*watchdog:/m.test(text)).toBe(false);
  });

  it('init.ts 不得写 root YAML watchdog: 块 / log_archive_days', () => {
    const text = fs.readFileSync(INIT_COMMAND, 'utf8');
    // 配置对象字面量里的 watchdog 段（注释行以 // 开头、不匹配）
    expect(/^\s*watchdog:\s*\{/m.test(text)).toBe(false);
    expect(/^\s*log_archive_days:/m.test(text)).toBe(false);
    expect(text.includes('WATCHDOG_INTERVAL_MS')).toBe(false);
    expect(text.includes('CLAW_INACTIVITY_TIMEOUT_MS')).toBe(false);
  });
});
