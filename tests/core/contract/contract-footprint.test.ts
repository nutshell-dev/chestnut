/**
 * phase 1424: ContractFootprint view function tests
 *
 * 验证 audit.tsv 行级 parse + filter (by contractId / timestamp) + 聚合 (writes/edits/submits/spawns/sends/reads/execCommands/toolCounts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { contractFootprint } from '../../../src/core/contract/contract-footprint.js';

describe('contractFootprint', () => {
  let testDir: string;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `contract-footprint-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty footprint when audit.tsv does not exist', async () => {
    const fp = await contractFootprint(nfs, 'c1');
    expect(fp.contractId).toBe('c1');
    expect(fp.writes).toEqual([]);
    expect(fp.edits).toEqual([]);
    expect(fp.submits).toEqual([]);
    expect(fp.execCommands).toEqual([]);
    expect(fp.toolCounts).toEqual({});
  });

  it('parses tool_exec rows by tool family (write/edit/read/exec) and aggregates counts', async () => {
    const lines = [
      '2026-05-29T10:00:00.000Z\tseq=1\ttool_exec\twrite\tpath=foo.md\tbytes=120',
      '2026-05-29T10:00:01.000Z\tseq=2\ttool_exec\tread\tpath=bar.md',
      '2026-05-29T10:00:02.000Z\tseq=3\ttool_exec\texec\tcommand=grep -r foo .\texit=0',
      '2026-05-29T10:00:03.000Z\tseq=4\ttool_exec\texec\tcommand=grep -r baz .\texit=1',
      '2026-05-29T10:00:04.000Z\tseq=5\ttool_exec\tedit\tpath=foo.md',
    ];
    fsSync.writeFileSync(path.join(testDir, 'audit.tsv'), lines.join('\n') + '\n');

    const fp = await contractFootprint(nfs, 'c1');
    expect(fp.writes).toEqual([{ file: 'foo.md', bytes: 120, step: 1 }]);
    expect(fp.reads).toEqual([{ file: 'bar.md', step: 2 }]);
    expect(fp.edits).toEqual([{ file: 'foo.md', step: 5 }]);
    expect(fp.execCommands).toEqual([
      { command: 'grep -r foo .', exitCode: 0, step: 3 },
      { command: 'grep -r baz .', exitCode: 1, step: 4 },
    ]);
    expect(fp.toolCounts).toEqual({ write: 1, read: 1, exec: 2, edit: 1 });
    expect(fp.stepRange).toEqual([1, 5]);
  });

  it('filters rows with contractId col by contractId', async () => {
    const lines = [
      '2026-05-29T10:00:00.000Z\tseq=1\tsubtask_completed\tcontractId=c1\tsubtaskId=s1',
      '2026-05-29T10:00:01.000Z\tseq=2\tsubtask_completed\tcontractId=c2\tsubtaskId=s2',
      '2026-05-29T10:00:02.000Z\tseq=3\tsubtask_completed\tcontractId=c1\tsubtaskId=s3',
    ];
    fsSync.writeFileSync(path.join(testDir, 'audit.tsv'), lines.join('\n') + '\n');

    const fp = await contractFootprint(nfs, 'c1');
    expect(fp.submits).toEqual([
      { subtaskId: 's1', step: 1 },
      { subtaskId: 's3', step: 3 },
    ]);
    expect(fp.toolCounts.submit_subtask).toBe(2);
  });

  it('filters by sinceTimestampMs', async () => {
    const lines = [
      '2026-05-29T10:00:00.000Z\tseq=1\ttool_exec\twrite\tpath=old.md\tbytes=10',
      '2026-05-29T10:00:05.000Z\tseq=2\ttool_exec\twrite\tpath=new.md\tbytes=20',
    ];
    fsSync.writeFileSync(path.join(testDir, 'audit.tsv'), lines.join('\n') + '\n');

    const sinceMs = Date.parse('2026-05-29T10:00:03.000Z');
    const fp = await contractFootprint(nfs, 'c1', { sinceTimestampMs: sinceMs });
    expect(fp.writes).toEqual([{ file: 'new.md', bytes: 20, step: 2 }]);
  });

  it('trims execCommands to recentExecN', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`2026-05-29T10:00:${String(i).padStart(2, '0')}.000Z\tseq=${i}\ttool_exec\texec\tcommand=cmd${i}\texit=0`);
    }
    fsSync.writeFileSync(path.join(testDir, 'audit.tsv'), lines.join('\n') + '\n');

    const fp = await contractFootprint(nfs, 'c1', { recentExecN: 3 });
    expect(fp.execCommands.length).toBe(3);
    expect(fp.execCommands.map(c => c.command)).toEqual(['cmd8', 'cmd9', 'cmd10']);
    // toolCounts 仍是全量计数（不被 trim 影响）
    expect(fp.toolCounts.exec).toBe(10);
  });

  it('handles malformed lines gracefully', async () => {
    const lines = [
      'not a valid line',
      '2026-05-29T10:00:00.000Z\tseq=1\ttool_exec\twrite\tpath=ok.md\tbytes=5',
      '',
      '\t\t\t',
    ];
    fsSync.writeFileSync(path.join(testDir, 'audit.tsv'), lines.join('\n') + '\n');

    const fp = await contractFootprint(nfs, 'c1');
    expect(fp.writes).toEqual([{ file: 'ok.md', bytes: 5, step: 1 }]);
  });
});
