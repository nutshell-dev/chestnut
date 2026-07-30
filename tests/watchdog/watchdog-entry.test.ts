/**
 * Phase 1247 Step B: Watchdog crash handler 测试。
 *
 * 验证可捕获崩溃在退出前写 `crashed` terminal；不可捕获终止（SIGKILL 模拟）
 * 不留 terminal，由下次 recovery 补 unclean。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import {
  setAuditWriter,
  _resetWatchdogContextForTest,
} from '../../src/watchdog/watchdog-context.js';
import { registerWatchdogCrashHandlers } from '../../src/watchdog/watchdog-crash-handler.js';
import {
  prepareCandidate,
  commitOwnership,
  inspectTerminal,
  WATCHDOG_ACTIVE_DIR,
  type WatchdogOwnerRecord,
} from '../../src/watchdog/watchdog-ownership.js';
import { newWatchdogAttempt } from '../../src/watchdog/watchdog-ownership.js';

let tmpDir: string;
let chestnutDir: string;
let auditWriter: AuditWriter;
const originalRoot = process.env.CHESTNUT_ROOT;

function makeRecord(overrides: Partial<WatchdogOwnerRecord> = {}): WatchdogOwnerRecord {
  return { ...newWatchdogAttempt(process.pid), ...overrides };
}

function readActiveJson(): string {
  return fs.readFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), 'utf-8');
}

beforeEach(() => {
  _resetWatchdogContextForTest();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-entry-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(chestnutDir, { recursive: true });
  process.env.CHESTNUT_ROOT = tmpDir;
  auditWriter = new AuditWriter(new NodeFileSystem({ baseDir: chestnutDir }), 'audit.tsv', null);
  setAuditWriter(auditWriter);
});

afterEach(() => {
  setAuditWriter(null);
  if (originalRoot !== undefined) {
    process.env.CHESTNUT_ROOT = originalRoot;
  } else {
    delete process.env.CHESTNUT_ROOT;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('registerWatchdogCrashHandlers', () => {
  it('uncaughtException 前写 crashed terminal 并退出', () => {
    const record = makeRecord();
    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);

    registerWatchdogCrashHandlers(fsFactory);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => {
      process.emit('uncaughtException', new Error('simulated crash'));
    }).toThrow('exit');
    exitSpy.mockRestore();

    const terminal = inspectTerminal(chestnutFs);
    expect(terminal.status).toBe('ok');
    if (terminal.status === 'ok') {
      expect(terminal.terminal.kind).toBe('crashed');
      expect(terminal.terminal.reason).toContain('simulated crash');
    }
    expect(JSON.parse(readActiveJson()).owner_token).toBe(record.owner_token);
  });

  it('unhandledRejection 前写 crashed terminal 并退出', () => {
    const record = makeRecord();
    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);

    registerWatchdogCrashHandlers(fsFactory);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => {
      process.emit('unhandledRejection', new Error('simulated rejection'));
    }).toThrow('exit');
    exitSpy.mockRestore();

    const terminal = inspectTerminal(chestnutFs);
    expect(terminal.status).toBe('ok');
    if (terminal.status === 'ok') {
      expect(terminal.terminal.kind).toBe('crashed');
      expect(terminal.terminal.reason).toContain('simulated rejection');
    }
  });

  it('无 active 时崩溃不抛错、仍调用 exit', () => {
    registerWatchdogCrashHandlers(fsFactory);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => {
      process.emit('uncaughtException', new Error('no active'));
    }).toThrow('exit');
    exitSpy.mockRestore();
  });
});
