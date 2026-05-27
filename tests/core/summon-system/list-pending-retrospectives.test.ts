/**
 * @module tests/core/summon-system/list-pending-retrospectives
 * Phase 1335 sub-4: listPendingRetrospectives cross-module query API
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listPendingRetrospectives, SUMMON_AUDIT_EVENTS } from '../../../src/core/summon-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('listPendingRetrospectives', () => {
  let testDir: string;
  let motionDir: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-list-pending-retro-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    motionDir = path.join(testDir, 'motion');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(motionDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty array when dir missing', async () => {
    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const result = await listPendingRetrospectives({ fs: nodeFs });
    expect(result).toEqual([]);
  });

  it('lists pending retrospectives with parse + validate', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'c1.json'),
      JSON.stringify({ contractId: 'c1', targetClaw: 'claw-a', mode: 'mining', miningTaskId: 't1', createdAt: '2024-01-01T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const result = await listPendingRetrospectives({ fs: nodeFs });

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('c1');
    expect(result[0].targetClaw).toBe('claw-a');
    expect(result[0].mode).toBe('mining');
    expect(result[0].miningTaskId).toBe('t1');
  });

  it('filters by contractId', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ targetClaw: 'x' }));
    await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify({ targetClaw: 'y' }));

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const result = await listPendingRetrospectives({ fs: nodeFs, filter: { contractId: 'b' } });

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('b');
  });

  it('skips invalid JSON and entries without targetClaw', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bad.json'), 'not-json');
    await fs.writeFile(path.join(dir, 'no-target.json'), JSON.stringify({ mode: 'mining' }));
    await fs.writeFile(path.join(dir, 'good.json'), JSON.stringify({ targetClaw: 'ok' }));

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const result = await listPendingRetrospectives({ fs: nodeFs });

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('good');
  });

  it('emits audit per file parse-fail and bulk listing does not crash', async () => {
    const dir = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bad.json'), 'not-json');
    await fs.writeFile(path.join(dir, 'good.json'), JSON.stringify({ targetClaw: 'ok' }));

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const mockAudit = makeMockAudit();
    const result = await listPendingRetrospectives({ fs: nodeFs, audit: mockAudit as any });

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('good');
    expect(mockAudit.write).toHaveBeenCalledWith(
      SUMMON_AUDIT_EVENTS.RETRO_INDEX_PARSE_FAILED,
      expect.stringContaining('contractId=bad'),
      expect.stringContaining('reason='),
    );
  });
});
