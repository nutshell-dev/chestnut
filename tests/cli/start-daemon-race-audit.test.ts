/**
 * start.ts daemonReady race audit tests — phase 816 Step B3
 *
 * 验证 daemonReady.catch 内 audit emit + await daemonReady rethrow 保留
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startPath = path.join(__dirname, '../../src/cli/commands/start.ts');
const auditEventsPath = path.join(__dirname, '../../src/cli/audit-events.ts');

describe('start.ts daemonReady race audit (phase 816 B3)', () => {
  const sourceCode = fs.readFileSync(startPath, 'utf-8');
  const auditEventsCode = fs.readFileSync(auditEventsPath, 'utf-8');

  it('audit-events.ts 含 DAEMON_SPAWN_RACE_FAILED const', () => {
    expect(auditEventsCode).toMatch(/DAEMON_SPAWN_RACE_FAILED:\s*'cli_daemon_spawn_race_failed'/);
  });

  it('start.ts 导入 CLI_AUDIT_EVENTS', () => {
    expect(sourceCode).toContain("import { CLI_AUDIT_EVENTS } from '../audit-events.js';");
  });

  it('daemonReady.catch 不再是空箭头函数', () => {
    expect(sourceCode).not.toContain('daemonReady.catch(() => {});');
    expect(sourceCode).toContain('daemonReady.catch((err: unknown) => {');
  });

  it('catch 内使用 CLI_AUDIT_EVENTS.DAEMON_SPAWN_RACE_FAILED', () => {
    expect(sourceCode).toContain('CLI_AUDIT_EVENTS.DAEMON_SPAWN_RACE_FAILED');
  });

  it('catch 内 audit 含 context=first_run_parallel_pickLanguage', () => {
    expect(sourceCode).toContain('context=first_run_parallel_pickLanguage');
  });

  it('catch 内 audit 使用 notifyAudit?.write', () => {
    expect(sourceCode).toContain('notifyAudit?.write(');
  });

  it('catch 不 rethrow（保留 await daemonReady 路径）', () => {
    const idx = sourceCode.indexOf('daemonReady.catch((err: unknown) => {');
    expect(idx).toBeGreaterThan(-1);
    // 取 catch 块到下一个语句
    const blockStart = idx;
    const blockEnd = sourceCode.indexOf('const language = await pickLanguage();', blockStart);
    const block = sourceCode.slice(blockStart, blockEnd);
    // 块内不含 throw 语句（排除注释中的 rethrow）
    expect(block).not.toMatch(/throw\s+err/);
    expect(block).not.toMatch(/throw\s*;/);
  });

  it('await daemonReady 仍保留', () => {
    expect(sourceCode).toContain('await daemonReady;');
  });
});
