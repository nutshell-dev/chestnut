import { describe, it, expect, beforeEach } from 'vitest';
import { listMigratedExecTasks } from '../../src/core/async-task-system/index.js';
import { TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_RESULTS_DIR } from '../../src/core/async-task-system/dirs.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { FileSystem } from '../../src/foundation/fs/index.js';

describe('listMigratedExecTasks', () => {
  let tmpDir: string;
  let clawDir: string;
  let runningDir: string;
  let resultsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chestnut-test-'));
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    runningDir = path.join(clawDir, TASKS_QUEUES_RUNNING_DIR);
    resultsDir = path.join(clawDir, TASKS_QUEUES_RESULTS_DIR);
    fs.mkdirSync(runningDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });
  });

  const makeDeps = () => ({
    fsFactory: (baseDir: string) => (({
      existsSync: (p: string) => {
        const full = path.join(baseDir, p);
        try { fs.statSync(full); return true; } catch { return false; }
      },
      listSync: (p: string) => {
        const full = path.join(baseDir, p);
        return fs.readdirSync(full, { withFileTypes: true }).map(d => ({
          name: d.name,
          path: d.name,
          isDirectory: d.isDirectory(),
          isFile: d.isFile(),
          size: 0,
          mtime: new Date(),
        }));
      },
      readSync: (p: string) => fs.readFileSync(path.join(baseDir, p), 'utf-8'),
      statSync: (p: string) => {
        const s = fs.statSync(path.join(baseDir, p));
        return { mtime: s.mtime, size: s.size, ctime: s.ctime, isDirectory: s.isDirectory(), isFile: s.isFile() };
      },
    }) as unknown as FileSystem),
  });

  function writeTaskFile(taskId: string, overrides: Record<string, unknown> = {}) {
    const shortId = taskId.slice(0, 8);
    const task = {
      kind: 'tool',
      id: taskId,
      shortId,
      toolName: 'exec',
      args: { command: 'echo hello' },
      parentClawDir: '/test',
      parentClawId: 'parent-1',
      createdAt: new Date().toISOString(),
      isIdempotent: false,
      maxRetries: 2,
      retryCount: 0,
      mode: 'migrated',
      ...overrides,
    };
    fs.writeFileSync(path.join(runningDir, `${taskId}.json`), JSON.stringify(task));
  }

  // ── 8 test cases ──

  it('returns empty when no running dir', () => {
    fs.rmSync(runningDir, { recursive: true });
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns valid migrated exec task', () => {
    writeTaskFile('11111111-1111-4111-9111-111111111111');
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe('11111111');
    expect(result.tasks[0].command).toBe('echo hello');
    expect(result.errors).toEqual([]);
  });

  it('reports error for corrupted JSON', () => {
    fs.writeFileSync(path.join(runningDir, 'bad.json'), '{not valid json');
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe('bad');
  });

  it('reports error for schema mismatch (missing id)', () => {
    writeTaskFile('22222222-2222-4222-a222-222222222222', { id: undefined });
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('schema mismatch');
  });

  it('reports error for non-string command', () => {
    writeTaskFile('33333333-3333-4333-a333-333333333333', { args: { command: { program: 'curl' } } });
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('args.command must be a string');
  });

  it('reports error when filename ID does not match task.id', () => {
    writeTaskFile('55555555-5555-4555-a555-555555555555', { id: '66666666-6666-4666-a666-666666666666' });
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('does not match');
  });

  it('result.txt ENOENT → lastOutputMs is null, no error', () => {
    writeTaskFile('66666666-6666-4666-a666-666666666666');
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].lastOutputMs).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it('mixes valid tasks and corrupted entries', () => {
    writeTaskFile('77777777-7777-4777-a777-777777777777');
    fs.writeFileSync(path.join(runningDir, 'bad.json'), '{corrupt');
    writeTaskFile('88888888-8888-4888-a888-888888888888');
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.tasks.map(t => t.taskId).sort()).toEqual(['77777777', '88888888']);
  });

  // ── phase 845 expanded coverage ──

  it('emits TASK_QUERY_FILE_CORRUPT audit for corrupted JSON', () => {
    const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const auditWriter = {
      write: (event: string, payload: Record<string, unknown>) => auditEvents.push({ event, payload }),
    };
    const deps = { ...makeDeps(), auditWriter };
    fs.writeFileSync(path.join(runningDir, 'bad.json'), '{not valid');
    listMigratedExecTasks(deps, clawDir);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].event).toBe('task_query_file_corrupt');
    expect(auditEvents[0].payload.taskId).toBe('bad');
  });

  it('emits TASK_QUERY_FILE_CORRUPT audit for filename/content ID mismatch', () => {
    const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const deps = {
      ...makeDeps(),
      auditWriter: {
        write: (event: string, payload: Record<string, unknown>) => auditEvents.push({ event, payload }),
      },
    };
    writeTaskFile('55555555-5555-4555-a555-555555555555', { id: 'content-id' });
    listMigratedExecTasks(deps, clawDir);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].event).toBe('task_query_file_corrupt');
    expect(auditEvents[0].payload.taskId).toBe('55555555');
  });

  it('silently skips non-migrated tool tasks', () => {
    writeTaskFile('99999999-9999-4999-a999-999999999999', { mode: 'fresh' });
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports error for invalid createdAt', () => {
    writeTaskFile('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', { createdAt: 'broken' });
    const result = listMigratedExecTasks(makeDeps(), clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('createdAt is not a parseable datetime');
  });

  // ── phase 846 expanded coverage ──

  it('returns error and audit when listSync throws', () => {
    const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const deps = {
      ...makeDeps(),
      fsFactory: (baseDir: string) => {
        const fs = makeDeps().fsFactory(baseDir);
        return {
          ...fs,
          listSync: () => {
            throw new Error('EACCES: permission denied');
          },
        } as unknown as FileSystem;
      },
      auditWriter: {
        write: (event: string, payload: Record<string, unknown>) => auditEvents.push({ event, payload }),
      },
    };
    const result = listMigratedExecTasks(deps, clawDir);
    expect(result.tasks).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe('(directory)');
    expect(result.errors[0].reason).toContain('Cannot list running queue');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].event).toBe('task_query_file_corrupt');
    expect(auditEvents[0].payload.taskId).toBe('(directory)');
  });
});
