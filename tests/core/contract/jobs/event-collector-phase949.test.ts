/**
 * Phase 949: event-collector cursor fallback + schema audit + active-state audit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  collectContractEvents,
  scanArchivedContracts,
} from '../../../../src/core/contract/jobs/event-collector.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';

describe('phase 949: event-collector cursor / schema / active-state fixes', () => {
  let chestnutRoot: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    chestnutRoot = path.join(tmpdir(), `event-collector-phase949-${randomUUID()}`);
    await fsAsync.mkdir(chestnutRoot, { recursive: true });
    fs = new NodeFileSystem({ baseDir: chestnutRoot });
  });

  afterEach(async () => {
    await fsAsync.rm(chestnutRoot, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  async function makeContract(
    clawSub: string,
    contractDirName: string,
    progressJson: string,
  ) {
    const archiveDir = path.join(chestnutRoot, clawSub, 'contract/archive', contractDirName);
    await fsAsync.mkdir(archiveDir, { recursive: true });
    await fsAsync.writeFile(path.join(archiveDir, 'progress.json'), progressJson);
  }

  it('cancelled + zero completed subtasks gets archivedAt from progress.json mtime', async () => {
    const { audit, events } = makeAudit();
    await makeContract('claws/worker-1', '1780-cancelled', JSON.stringify({
      schema_version: 1,
      contract_id: '1780-cancelled',
      status: 'cancelled',
      checkpoint: 'cancelled: user manual',
      subtasks: {},
    }));

    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const entries = scanArchivedContracts(fs, clawDir, 'worker-1', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('cancelled');
    expect(entries[0].archivedAt).toBeGreaterThan(0);

    // Observer-style sinceTs filter: previous watermark before archivedAt should NOT drop the event
    const result = collectContractEvents(fs, clawDir, 'worker-1', entries[0].archivedAt - 1, audit);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toContain('[contract_cancelled]');
    expect(events).toHaveLength(0);
  });

  it('schema validation failure emits PROGRESS_CORRUPTED and continues scanning other contracts', async () => {
    const { audit, events } = makeAudit();
    await makeContract('claws/worker-1', '1780-bad', JSON.stringify({
      // schema_version must be 1; invalid status fails loose enum validation
      schema_version: 1,
      contract_id: '1780-bad',
      status: 'not_a_valid_status',
      subtasks: {},
    }));
    await makeContract('claws/worker-1', '1780-good', JSON.stringify({
      schema_version: 1,
      contract_id: '1780-good',
      status: 'completed',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'src/a.ts', completed_at: '2026-05-31T00:00:00Z' },
      },
    }));

    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const entries = scanArchivedContracts(fs, clawDir, 'worker-1', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].contractId).toBe('1780-good');

    const corruptedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED);
    expect(corruptedEvents).toHaveLength(1);
    expect(corruptedEvents[0].join(' ')).toContain('1780-bad');
    expect(corruptedEvents[0].join(' ')).toContain('schema_validation_failed');
  });

  it('active status in archive returns structured failure and emits collector audit', async () => {
    const { audit, events } = makeAudit();
    await makeContract('claws/worker-1', '1780-running', JSON.stringify({
      schema_version: 1,
      contract_id: '1780-running',
      status: 'running',
      checkpoint: null,
      subtasks: {},
    }));

    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const entries = scanArchivedContracts(fs, clawDir, 'worker-1', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('running');
    expect(entries[0].hasFailure).toBe(true);
    expect(entries[0].reason).toBe('state_machine_break');
    expect(entries[0].cause).toContain('active status "running" in archive');

    const activeEvents = events.filter(
      e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
    );
    expect(activeEvents).toHaveLength(1);
    expect(activeEvents[0].join(' ')).toContain('1780-running');
    expect(activeEvents[0].join(' ')).toContain('status=running');
  });
});
