/** Phase 2153 Step B1：可捕获 crash 的 typed terminal、audit 与 raw fallback 证据。 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import {
  setAuditWriter,
  _resetWatchdogContextForTest,
} from '../../src/watchdog/watchdog-context.js';
import {
  recordCrashTerminal,
  registerWatchdogCrashHandlers,
} from '../../src/watchdog/watchdog-crash-handler.js';
import {
  prepareCandidate,
  commitOwnership,
  newWatchdogAttempt,
  WATCHDOG_ACTIVE_DIR,
  type WatchdogOwnerRecord,
} from '../../src/watchdog/watchdog-ownership.js';

const fsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });
const originalRoot = process.env.CHESTNUT_ROOT;
let tmpDir: string;
let chestnutDir: string;
let auditWriter: AuditWriter;

function makeRecord(): WatchdogOwnerRecord {
  return newWatchdogAttempt(process.pid);
}

function seedActive(record: WatchdogOwnerRecord = makeRecord()): NodeFileSystem {
  const chestnutFs = fsFactory(chestnutDir);
  prepareCandidate(chestnutFs, record);
  commitOwnership(chestnutFs, record);
  return chestnutFs;
}

function readRawFallback(): string {
  const output = path.join(chestnutDir, WATCHDOG_PATHS.process_output);
  return fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
}

function captureHandler(
  event: 'uncaughtException' | 'unhandledRejection',
  factory: (baseDir: string) => NodeFileSystem = fsFactory,
): (reason: unknown) => void {
  let captured: ((reason: unknown) => void) | undefined;
  const onSpy = vi.spyOn(process, 'on').mockImplementation(((
    eventName: string,
    listener: (reason: unknown) => void,
  ) => {
    if (eventName === event) captured = listener;
    return process;
  }) as typeof process.on);
  registerWatchdogCrashHandlers(factory);
  onSpy.mockRestore();
  expect(captured).toBeDefined();
  return captured!;
}

beforeEach(() => {
  _resetWatchdogContextForTest();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-crash-evidence-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(chestnutDir, { recursive: true });
  process.env.CHESTNUT_ROOT = tmpDir;
  auditWriter = new AuditWriter(fsFactory(chestnutDir), 'audit.tsv', null);
  setAuditWriter(auditWriter);
});

afterEach(() => {
  setAuditWriter(null);
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recordCrashTerminal typed results', () => {
  it('recorded：写入 crashed terminal 并返回 active identity', () => {
    const record = makeRecord();
    seedActive(record);

    const result = recordCrashTerminal(fsFactory, new Error('crash-recorded'));

    expect(result.kind).toBe('recorded');
    expect(result.identity).toEqual({
      attemptId: record.attempt_id,
      ownerToken: record.owner_token,
      pid: record.pid,
    });
    const terminal = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json'), 'utf8',
    ));
    expect(terminal.kind).toBe('crashed');
    expect(terminal.reason).toContain('crash-recorded');
  });

  it('already_recorded：保留 first terminal，不覆盖原始 crash', () => {
    seedActive();
    const terminalPath = path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json');
    const first = { kind: 'crashed', reason: 'first', recorded_at: new Date().toISOString() };
    fs.writeFileSync(terminalPath, JSON.stringify(first));

    const result = recordCrashTerminal(fsFactory, new Error('second'));

    expect(result.kind).toBe('already_recorded');
    expect(JSON.parse(fs.readFileSync(terminalPath, 'utf8'))).toEqual(first);
  });

  it('no_active：无 owner 时显式返回，不伪装已记录', () => {
    const result = recordCrashTerminal(fsFactory, new Error('no-active'));
    expect(result).toMatchObject({ kind: 'no_active', identity: null });
  });

  it('mismatch：active 在读取与写入间换代时保留 fresh generation', () => {
    const record = makeRecord();
    const chestnutFs = seedActive(record);
    const originalRead = chestnutFs.readSync.bind(chestnutFs);
    let activeReads = 0;
    vi.spyOn(chestnutFs, 'readSync').mockImplementation((target) => {
      if (target === `${WATCHDOG_ACTIVE_DIR}/owner.json`) {
        activeReads++;
        if (activeReads === 2) {
          return JSON.stringify({ ...record, owner_token: 'fresh-owner-token' });
        }
      }
      return originalRead(target);
    });

    const result = recordCrashTerminal(() => chestnutFs, new Error('race'));

    expect(result.kind).toBe('mismatch');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json'))).toBe(false);
  });

  it('malformed：坏 active owner 返回原始 parse cause', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), '{broken');

    const result = recordCrashTerminal(fsFactory, new Error('malformed'));

    expect(result.kind).toBe('malformed');
    expect('cause' in result ? String(result.cause) : '').toMatch(/JSON|Unexpected|position/i);
  });

  it('failed：exclusive terminal 写错误保留原始 cause', () => {
    seedActive();
    const failingFs = fsFactory(chestnutDir);
    vi.spyOn(failingFs, 'writeExclusiveSync').mockImplementation(() => {
      throw new Error('terminal-EIO');
    });

    const result = recordCrashTerminal(() => failingFs, new Error('write-failed'));

    expect(result.kind).toBe('failed');
    expect('cause' in result ? String(result.cause) : '').toContain('terminal-EIO');
  });
});

describe('crash audit and raw fallback', () => {
  it('crash audit 带 terminal 与 attempt/token/pid，dispose 先于 exit', () => {
    const record = makeRecord();
    seedActive(record);
    const events: string[] = [];
    const originalWrite = auditWriter.write.bind(auditWriter);
    vi.spyOn(auditWriter, 'write').mockImplementation((type, ...cols) => {
      if (type === WATCHDOG_AUDIT_EVENTS.CRASH) events.push('audit');
      return originalWrite(type, ...cols);
    });
    vi.spyOn(auditWriter, 'dispose').mockImplementation(() => {
      events.push('dispose');
      return null;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      events.push('exit');
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('uncaughtException');

    expect(() => handler(new Error('ordered-crash'))).toThrow('exit');

    expect(events).toEqual(['audit', 'dispose', 'exit']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const audit = fs.readFileSync(path.join(chestnutDir, 'audit.tsv'), 'utf8');
    expect(audit).toContain('watchdog_crash');
    expect(audit).toContain('terminal=recorded');
    expect(audit).toContain(`attempt=${record.attempt_id}`);
    expect(audit).toContain(`owner_token=${record.owner_token}`);
    expect(audit).toContain(`pid=${record.pid}`);
  });

  it('unhandledRejection 使用同一 typed 证据链', () => {
    const record = makeRecord();
    seedActive(record);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('unhandledRejection');

    expect(() => handler('rejection-reason')).toThrow('exit');

    const terminal = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'terminal.json'), 'utf8',
    ));
    expect(terminal.kind).toBe('crashed');
    expect(terminal.reason).toContain('rejection-reason');
    expect(fs.readFileSync(path.join(chestnutDir, 'audit.tsv'), 'utf8'))
      .toContain(`owner_token=${record.owner_token}`);
  });

  it('audit writer 缺失：仍退出并在 raw sink 留 audit_unavailable', () => {
    const record = makeRecord();
    seedActive(record);
    setAuditWriter(null);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('uncaughtException');

    expect(() => handler(new Error('missing-audit'))).toThrow('exit');

    const raw = readRawFallback();
    expect(raw).toContain('stage=audit_unavailable');
    expect(raw).toContain(`attempt=${record.attempt_id}`);
    expect(raw).toContain('missing-audit');
  });

  it('audit append 返回 pending_fallback：raw fallback 保留阶段、原始 cause 与 active identity', () => {
    const record = makeRecord();
    seedActive(record);
    const originalWrite = auditWriter.write.bind(auditWriter);
    vi.spyOn(auditWriter, 'write').mockImplementation((type, ...cols) => {
      if (type === WATCHDOG_AUDIT_EVENTS.CRASH) {
        return {
          kind: 'pending_fallback',
          path: 'audit.tsv',
          row: 'watchdog_crash-row',
          error: new Error('audit-EACCES'),
        };
      }
      return originalWrite(type, ...cols);
    });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('uncaughtException');

    expect(() => handler(new Error('audit-failed-crash'))).toThrow('exit');

    const raw = readRawFallback();
    expect(raw).toContain('stage=audit_failed');
    expect(raw).toContain('pending_fallback');
    expect(raw).toContain('audit-EACCES');
    expect(raw).toContain(`attempt=${record.attempt_id}`);
    expect(raw).toContain(`owner_token=${record.owner_token}`);
    expect(raw).toContain(`pid=${record.pid}`);
  });

  it('raw fallback 也失败：stderr 同时保留 fallback cause 与完整原始行', () => {
    const record = makeRecord();
    seedActive(record);
    const failingFs = fsFactory(chestnutDir);
    vi.spyOn(failingFs, 'appendSync').mockImplementation(() => {
      throw new Error('raw-ENOSPC');
    });
    const originalWrite = auditWriter.write.bind(auditWriter);
    vi.spyOn(auditWriter, 'write').mockImplementation((type, ...cols) => {
      if (type === WATCHDOG_AUDIT_EVENTS.CRASH) throw new Error('audit-EACCES');
      return originalWrite(type, ...cols);
    });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('uncaughtException', () => failingFs);

    expect(() => handler(new Error('double-failure'))).toThrow('exit');

    const output = stderr.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(output).toContain('process-output fallback failed');
    expect(output).toContain('raw-ENOSPC');
    expect(output).toContain('stage=audit_failed');
    expect(output).toContain('audit-EACCES');
    expect(output).toContain(`attempt=${record.attempt_id}`);
    expect(output).toContain('double-failure');
  });

  it('terminal 写失败不静默：raw sink 保留 cause/identity，active 不 retire', () => {
    const record = makeRecord();
    seedActive(record);
    const failingFs = fsFactory(chestnutDir);
    vi.spyOn(failingFs, 'writeExclusiveSync').mockImplementation(() => {
      throw new Error('terminal-handler-EIO');
    });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('uncaughtException', () => failingFs);

    expect(() => handler(new Error('terminal-handler-crash'))).toThrow('exit');

    const raw = readRawFallback();
    expect(raw).toContain('stage=terminal_failed');
    expect(raw).toContain('terminal-handler-EIO');
    expect(raw).toContain(`attempt=${record.attempt_id}`);
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'))).toBe(true);
  });

  it('terminal no_active 不静默：raw sink 明确记录未确认终局', () => {
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = captureHandler('uncaughtException');

    expect(() => handler(new Error('no-active-crash'))).toThrow('exit');

    expect(readRawFallback()).toContain('stage=terminal_no_active');
    expect(readRawFallback()).toContain('no-active-crash');
  });
});
