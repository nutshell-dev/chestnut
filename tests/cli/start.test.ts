/**
 * Phase 81 — start.ts 单元测试
 *
 * 覆盖：
 *   buildOnboardingSubtasks — 语言分支（auto / 具体文本）
 *   pickLanguage            — 输入映射：1→English, 2→中文, 空→auto, 任意文本→原样
 *   getOnboardingStatus     — not_found / in_progress / complete
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// ── readline mock ──────────────────────────────────────────────────────────────
const { rlAnswer } = vi.hoisted(() => ({ rlAnswer: { value: '' } }));

vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: (a: string) => void) => {
      cb(rlAnswer.value);
    }),
    close: vi.fn(),
  })),
}));

const { buildOnboardingSubtasks, pickLanguage, getOnboardingStatus } =
  await import('../../src/cli/commands/start.js');

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(tmpdir(), `chestnut-start-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeContract(
  motionDir: string,
  bucket: 'active' | 'paused' | 'archive',
  contractId: string,
  title: string,
  subtasks: Record<string, { status: string }>,
): void {
  const dir = path.join(motionDir, 'contract', bucket, contractId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'contract.yaml'), `title: "${title}"\n`);
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks }));
}

// ── buildOnboardingSubtasks ────────────────────────────────────────────────────

describe('buildOnboardingSubtasks', () => {
  it('language="auto" → subtask 含 "Detect"，不含具体语言名', () => {
    const lang = buildOnboardingSubtasks('auto').find(s => s.id === 'language')!;
    expect(lang.description).toContain('Detect');
    expect(lang.description).not.toContain('"auto"');
  });

  it('language="English" → subtask 含 "English"', () => {
    const lang = buildOnboardingSubtasks('English').find(s => s.id === 'language')!;
    expect(lang.description).toContain('"English"');
  });

  it('language="中文" → subtask 含 "中文"', () => {
    const lang = buildOnboardingSubtasks('中文').find(s => s.id === 'language')!;
    expect(lang.description).toContain('"中文"');
  });

  it('任意词（你好）→ subtask 含原文本', () => {
    const lang = buildOnboardingSubtasks('你好').find(s => s.id === 'language')!;
    expect(lang.description).toContain('"你好"');
  });

  it('任意词（hello）→ subtask 不含 "auto"', () => {
    const lang = buildOnboardingSubtasks('hello').find(s => s.id === 'language')!;
    expect(lang.description).toContain('"hello"');
    expect(lang.description).not.toMatch(/\bauto\b/);
  });

  it('返回 7 个 subtask，首个 id 为 "language"', () => {
    const subtasks = buildOnboardingSubtasks('auto');
    expect(subtasks).toHaveLength(7);
    expect(subtasks[0].id).toBe('language');
  });
});

// ── pickLanguage ───────────────────────────────────────────────────────────────

describe('pickLanguage', () => {
  it('"1" → "1"（不再做数字映射，原样返回）', async () => {
    rlAnswer.value = '1';
    expect(await pickLanguage()).toBe('1');
  });

  it('"2" → "2"（不再做数字映射，原样返回）', async () => {
    rlAnswer.value = '2';
    expect(await pickLanguage()).toBe('2');
  });

  it('空字符串 → "auto"', async () => {
    rlAnswer.value = '';
    expect(await pickLanguage()).toBe('auto');
  });

  it('任意英文词 → 原样返回', async () => {
    rlAnswer.value = 'hello';
    expect(await pickLanguage()).toBe('hello');
  });

  it('中文词 → 原样返回', async () => {
    rlAnswer.value = '你好';
    expect(await pickLanguage()).toBe('你好');
  });

  it('pickLanguage 输出直接传入 buildOnboardingSubtasks → subtask 含原文本', async () => {
    rlAnswer.value = 'bonjour';
    const lang = await pickLanguage();
    const desc = buildOnboardingSubtasks(lang).find(s => s.id === 'language')!.description;
    expect(desc).toContain('"bonjour"');
    expect(desc).not.toMatch(/\bauto\b/);
  });
});

// ── getOnboardingStatus ────────────────────────────────────────────────────────

describe('getOnboardingStatus', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('无 contract 目录 → not_found', () => {
    expect(getOnboardingStatus(tmpDir, { fsFactory })).toEqual({ state: 'not_found' });
  });

  it('active/ 中无 Onboarding 契约 → not_found', () => {
    writeContract(tmpDir, 'active', 'c1', 'SomeOtherTask', { step1: { status: 'completed' } });
    expect(getOnboardingStatus(tmpDir, { fsFactory })).toEqual({ state: 'not_found' });
  });

  it('active/ 中 Onboarding 有 pending subtask → in_progress', () => {
    writeContract(tmpDir, 'active', 'ob1', 'Onboarding', {
      language: { status: 'completed' },
      identity: { status: 'pending' },
      user: { status: 'pending' },
    });
    const result = getOnboardingStatus(tmpDir, { fsFactory });
    expect(result.state).toBe('in_progress');
    if (result.state === 'in_progress') {
      expect(result.contractId).toBe('ob1');
      expect(result.pending).toContain('identity');
      expect(result.pending).toContain('user');
      expect(result.pending).not.toContain('language');
    }
  });

  it('active/ 中 Onboarding 全部完成 → in_progress（archive 才算 complete）', () => {
    writeContract(tmpDir, 'active', 'ob1', 'Onboarding', {
      language: { status: 'completed' },
      identity: { status: 'completed' },
    });
    expect(getOnboardingStatus(tmpDir, { fsFactory }).state).toBe('in_progress');
  });

  it('archive/ 中 Onboarding 全部完成 → complete', () => {
    writeContract(tmpDir, 'archive', 'ob1', 'Onboarding', {
      language: { status: 'completed' },
      identity: { status: 'completed' },
      user: { status: 'completed' },
    });
    expect(getOnboardingStatus(tmpDir, { fsFactory })).toEqual({ state: 'complete' });
  });

  it('archive/ 中 Onboarding 有 pending → in_progress', () => {
    writeContract(tmpDir, 'archive', 'ob1', 'Onboarding', {
      language: { status: 'completed' },
      soul: { status: 'pending' },
    });
    const result = getOnboardingStatus(tmpDir, { fsFactory });
    expect(result.state).toBe('in_progress');
    if (result.state === 'in_progress') {
      expect(result.pending).toContain('soul');
    }
  });

  it('paused/ 中 Onboarding → in_progress', () => {
    writeContract(tmpDir, 'paused', 'ob1', 'Onboarding', {
      language: { status: 'pending' },
    });
    expect(getOnboardingStatus(tmpDir, { fsFactory }).state).toBe('in_progress');
  });

  it('progress.json 损坏 → 跳过该契约，返回 not_found', () => {
    const dir = path.join(tmpDir, 'contract', 'active', 'bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contract.yaml'), 'title: "Onboarding"\n');
    fs.writeFileSync(path.join(dir, 'progress.json'), '{broken json}}}');
    expect(getOnboardingStatus(tmpDir, { fsFactory })).toEqual({ state: 'not_found' });
  });
});
