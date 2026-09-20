/**
 * phase 1879 Step C: loadSessionFile（DialogStore owner 的 session 文件读取查询）。
 *
 * 矩阵（与迁移前 CLI session-parser 内联实现逐语义等价）：
 * ① current 存在 → source=current，内容经 parseSessionData 归一；
 * ② current 缺失 + archive/ 有归档 → source=archive，取 {ts}_ 前缀最新（ts 降序首个）；
 * ③ current 缺失 + archive/ 目录缺失 → not_found（archiveDirExists=false）；
 * ④ current 缺失 + archive/ 空 → not_found（archiveDirExists=true）；
 * ⑤ 版本未知（future）→ rejected（current / archive 两态分别携带定位信息）；
 * ⑥ JSON.parse 失败原样上抛（读取未知 ≠ 不存在）；
 * ⑦ 非 {ts}_ 前缀文件不参与归档选择。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { loadSessionFile } from '../../../src/foundation/dialog-store/index.js';

let tmpDir: string;
let sessionDir: string;
let currentPath: string;

function writeSession(filePath: string, marker: string, version = 2): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    version,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    systemPrompt: '',
    messages: [{ role: 'assistant', content: marker }],
    toolsForLLM: [],
  }));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1879-session-file-'));
  sessionDir = path.join(tmpDir, 'dialog');
  currentPath = path.join(sessionDir, 'current.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('phase 1879 Step C: loadSessionFile（owner session 文件查询）', () => {
  it('① current 存在 → source=current', () => {
    writeSession(currentPath, 'from-current');
    const outcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.source).toBe('current');
    expect(outcome.session.messages[0].content).toBe('from-current');
  });

  it('② current 缺失 → 最新 archive 回落（ts 降序首个）', () => {
    writeSession(path.join(sessionDir, 'archive', '1000_aaa.json'), 'old');
    writeSession(path.join(sessionDir, 'archive', '3000_ccc.json'), 'newest');
    writeSession(path.join(sessionDir, 'archive', '2000_bbb.json'), 'mid');
    const outcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.source).toBe('archive');
    if (outcome.source !== 'archive') return;
    expect(outcome.archiveName).toBe('3000_ccc.json');
    expect(outcome.session.messages[0].content).toBe('newest');
  });

  it('③ current 缺失 + archive/ 目录缺失 → not_found(archiveDirExists=false)', () => {
    fs.mkdirSync(sessionDir, { recursive: true });
    const outcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(outcome).toEqual({ kind: 'not_found', archiveDirExists: false });
  });

  it('④ current 缺失 + archive/ 空 → not_found(archiveDirExists=true)', () => {
    fs.mkdirSync(path.join(sessionDir, 'archive'), { recursive: true });
    const outcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(outcome).toEqual({ kind: 'not_found', archiveDirExists: true });
  });

  it('⑤ 版本未知：current → rejected(source=current)；archive → rejected(source=archive, archiveName)', () => {
    writeSession(currentPath, 'future', 999);
    const currentOutcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(currentOutcome).toEqual({ kind: 'rejected', source: 'current' });

    fs.rmSync(currentPath);
    writeSession(path.join(sessionDir, 'archive', '1000_aaa.json'), 'future-archive', 999);
    const archiveOutcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(archiveOutcome).toEqual({ kind: 'rejected', source: 'archive', archiveName: '1000_aaa.json' });
  });

  it('⑥ JSON.parse 失败原样上抛（SyntaxError；不折 not_found）', () => {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(currentPath, '{not json');
    expect(() => loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath)).toThrow(SyntaxError);
  });

  it('⑦ 非 {ts}_ 前缀/非 .json 文件不参与归档选择', () => {
    writeSession(path.join(sessionDir, 'archive', 'notes.json'), 'not-an-archive');
    writeSession(path.join(sessionDir, 'archive', 'abc_111.json'), 'bad-prefix');
    const outcome = loadSessionFile(new NodeFileSystem({ baseDir: sessionDir }), currentPath);
    expect(outcome).toEqual({ kind: 'not_found', archiveDirExists: true });
  });
});
