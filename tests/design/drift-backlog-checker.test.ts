import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkDriftBacklog } from '../../scripts/check-drift-backlog.mjs';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const roots: string[] = [];

function fixture(): { designRoot: string; backlogFile: string } {
  const designRoot = createTrackedTempDirSync('drift-backlog-check-');
  roots.push(designRoot);
  const modulesDir = path.join(designRoot, 'modules');
  const backlogDir = path.join(modulesDir, 'drift-backlog');
  mkdirSync(backlogDir, { recursive: true });
  writeFileSync(path.join(modulesDir, 'l1_sample.md'), '# Sample\n');
  writeFileSync(path.join(backlogDir, 'README.md'), '# Drift Backlog\n');
  const backlogFile = path.join(backlogDir, 'l1_sample.md');
  writeFileSync(backlogFile, [
    '# Sample drift backlog',
    '',
    '> 对应 [Sample](../l1_sample.md)。',
    '',
    '### 7.A 必修违规',
    '',
    '| 条目 ID | 应然 | 违规形态 | 状态 |',
    '|---|---|---|---|',
    '| **A.sample-open** | expected | drift | open |',
    '',
    '### 7.B 偏差登记',
    '',
    '| 条目 ID | 应然 | 实然偏差 | 升档条件 |',
    '|---|---|---|---|',
    '| **B.sample-open** | expected | accepted | trigger |',
    '',
  ].join('\n'));
  return { designRoot, backlogFile };
}

afterEach(() => {
  while (roots.length > 0) cleanupTempDirSync(roots.pop()!);
});

describe('drift-backlog checker', () => {
  it('accepts a complete live-only module ledger', () => {
    const { designRoot } = fixture();
    expect(checkDriftBacklog(designRoot)).toEqual([]);
  });

  it('rejects a missing module skeleton', () => {
    const { designRoot, backlogFile } = fixture();
    rmSync(backlogFile);
    expect(checkDriftBacklog(designRoot)).toContainEqual(expect.stringContaining('missing module backlog'));
  });

  it('rejects struck closed rows and malformed tables', () => {
    const { designRoot, backlogFile } = fixture();
    writeFileSync(backlogFile, [
      '# Sample drift backlog',
      '### 7.A 必修违规',
      '| 条目 ID | 应然 | 状态 |',
      '|---|---|---|',
      '| ~~**A.closed**~~ | expected | closed | extra |',
    ].join('\n'));
    const violations = checkDriftBacklog(designRoot);
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('closed/struck row'),
      expect.stringContaining('table has 4 columns; expected 3'),
    ]));
  });

  it('rejects broken links, duplicate IDs, and non-module files', () => {
    const { designRoot, backlogFile } = fixture();
    const backlogDir = path.dirname(backlogFile);
    writeFileSync(path.join(backlogDir, 'incident.md'), '# misplaced\n');
    writeFileSync(backlogFile, [
      '# Sample drift backlog',
      '> [missing](../missing.md)',
      '### 7.B 偏差登记',
      '| 条目 ID | 应然 | 实然偏差 | 升档条件 |',
      '|---|---|---|---|',
      '| **B.duplicate** | expected | accepted | trigger |',
      '| **B.duplicate** | expected | accepted | trigger |',
    ].join('\n'));
    const violations = checkDriftBacklog(designRoot);
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('non-module file'),
      expect.stringContaining('broken local link'),
      expect.stringContaining('duplicate live row ID'),
    ]));
  });

  it('rejects duplicate table headers and hand-written zero-state summaries', () => {
    const { designRoot, backlogFile } = fixture();
    writeFileSync(backlogFile, [
      '# Sample drift backlog',
      '### 7.B 偏差登记',
      '（截至旧 phase 0 ⚓ accepted-stable）',
      '| 条目 ID | 应然 | 实然偏差 | 升档条件 |',
      '|---|---|---|---|',
      '| 条目 ID | 应然 | 实然偏差 | 升档条件 |',
    ].join('\n'));
    const violations = checkDriftBacklog(designRoot);
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('duplicate table header'),
      expect.stringContaining('hand-written zero-state summary'),
    ]));
  });
});
