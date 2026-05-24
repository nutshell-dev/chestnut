/**
 * chat-viewport CRASH audit tests — phase 816 Step B1
 *
 * 验证 uncaughtHandler 内 sync audit emit（motion-level audit shim α 模板）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { FAKE_LIVE_PID, FAKE_LIVE_PID_STRING } from '../helpers/test-pids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewportPath = path.join(__dirname, '../../src/cli/commands/chat-viewport.ts');
const initPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-init.ts');
const auditEventsPath = path.join(__dirname, '../../src/cli/audit-events.ts');

describe('chat-viewport CRASH audit (phase 816 B1)', () => {
  const sourceCode = fs.readFileSync(viewportPath, 'utf-8')
    + fs.readFileSync(initPath, 'utf-8');
  const auditEventsCode = fs.readFileSync(auditEventsPath, 'utf-8');

  it('audit-events.ts 含 CHAT_CRASH_UNCAUGHT const', () => {
    expect(auditEventsCode).toMatch(/CHAT_CRASH_UNCAUGHT:\s*'cli_chat_crash_uncaught'/);
  });

  it('uncaughtHandler 内导入 createSystemAudit + NodeFileSystem', () => {
    expect(sourceCode).toContain("import { NodeFileSystem } from '../../foundation/fs/node-fs.js';");
    expect(sourceCode).toContain("import { createSystemAudit } from '../../foundation/audit/index.js';");
  });

  it('uncaughtHandler 内使用 CLI_AUDIT_EVENTS.CHAT_CRASH_UNCAUGHT', () => {
    expect(sourceCode).toContain('CLI_AUDIT_EVENTS.CHAT_CRASH_UNCAUGHT');
  });

  it('uncaughtHandler 内 audit shim 包 try-catch（fail-soft）', () => {
    // 找 uncaughtHandler 定义后的第一个 try 块包含 createSystemAudit
    const idx = sourceCode.indexOf('function uncaughtHandler(err: unknown): void {');
    expect(idx).toBeGreaterThan(-1);
    const block = sourceCode.slice(idx, idx + 1200);
    expect(block).toContain('createSystemAudit(');
    expect(block).toContain('new NodeFileSystem({ baseDir: deps.agentDir })');
    // fail-soft 外层 try + catch
    expect(block).toMatch(/try\s*\{[\s\S]*?createSystemAudit[\s\S]*?\}\s*catch/);
  });

  it('audit shim 含 pid + error + stack_head 字段', () => {
    expect(sourceCode).toContain('`pid=${process.pid}`');
    expect(sourceCode).toContain('`error=${errMsg}`');
    expect(sourceCode).toContain('`stack_head=${stack}`');
  });

  it('shim 构造失败时 crash log + stderr 路径仍保留', () => {
    // catch 后仍有 crash log appendSync + stderr.write
    const idx = sourceCode.indexOf('function uncaughtHandler(err: unknown): void {');
    const block = sourceCode.slice(idx, idx + 1800);
    expect(block).toContain('deps.fs.appendSync(deps.crashLogPath');
    expect(block).toContain('process.stderr.write(`[chat] uncaught error:');
  });

  describe('runtime: sync audit write via shim', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = path.join(tmpdir(), `cv-shim-test-${randomUUID()}`);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    it('createSystemAudit sync write 产生 audit.tsv row', async () => {
      const { NodeFileSystem } = await import('../../src/foundation/fs/node-fs.js');
      const { createSystemAudit } = await import('../../src/foundation/audit/index.js');
      const { CLI_AUDIT_EVENTS } = await import('../../src/cli/audit-events.js');

      const shimFs = new NodeFileSystem({ baseDir: tempDir });
      const shim = createSystemAudit(shimFs, tempDir);
      shim.write(
        CLI_AUDIT_EVENTS.CHAT_CRASH_UNCAUGHT,
        `pid=${FAKE_LIVE_PID}`,
        'error=TestError: test',
        'stack_head=TestError: test | at foo | at bar',
      );

      const auditPath = path.join(tempDir, 'audit.tsv');
      const content = fs.readFileSync(auditPath, 'utf-8');
      expect(content).toContain('cli_chat_crash_uncaught');
      expect(content).toContain(`pid=${FAKE_LIVE_PID}`);
      expect(content).toContain('error=TestError: test');
    });
  });
});
