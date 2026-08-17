/**
 * Phase 1198 Step A: lifecycle intent persistence and reader tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  persistLifecycleIntent,
  readLifecycleIntent,
  readLifecycleIntentsForContract,
  lifecycleIntentPath,
  buildCompletedIntent,
  buildCancelledIntent,
  buildCorruptedIntent,
  buildFailedIntent,
} from '../../../src/core/contract/lifecycle-intent.js';
import { makeContractId } from '../../../src/core/contract/types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = await createTempDir('test-lifecycle-intent-');
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await cleanupTempDir(tmpDir);
});

const contractId = makeContractId('cid-1');

function makeAuditCapture() {
  const events: Array<{ type: string; args: string[] }> = [];
  const audit = {
    write: (type: string, ...args: string[]) => {
      events.push({ type, args });
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

describe('persistLifecycleIntent', () => {
  it('writes an exclusive intent file and emits audit', async () => {
    const { audit, events } = makeAuditCapture();
    const intent = buildCancelledIntent(contractId, 'req-1', 'user request');

    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);

    const filePath = lifecycleIntentPath(clawDir, contractId, 'req-1');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.requested_state).toBe('cancelled');
    expect(parsed.reason).toBe('user request');
    expect(events.some(e => e.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_PERSISTED)).toBe(true);
  });

  it('is idempotent for identical payload with same request id', async () => {
    const { audit, events } = makeAuditCapture();
    const intent = buildCancelledIntent(contractId, 'req-1', 'user request');

    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);
    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);

    const dir = path.join(clawDir, 'contract', 'lifecycle-intents', contractId);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const persisted = events.filter(e => e.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_PERSISTED);
    expect(persisted).toHaveLength(2);
  });

  it('throws on request id collision with different payload', async () => {
    const { audit } = makeAuditCapture();
    const first = buildCancelledIntent(contractId, 'req-1', 'user request');
    const second = buildCancelledIntent(contractId, 'req-1', 'different reason');

    await persistLifecycleIntent(nodeFs, audit, clawDir, first);
    await expect(persistLifecycleIntent(nodeFs, audit, clawDir, second)).rejects.toThrow('collision');

    const filePath = lifecycleIntentPath(clawDir, contractId, 'req-1');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.reason).toBe('user request');
  });

  it('allows different request ids for the same contract', async () => {
    const { audit } = makeAuditCapture();
    await persistLifecycleIntent(nodeFs, audit, clawDir, buildCancelledIntent(contractId, 'req-a', 'a'));
    await persistLifecycleIntent(nodeFs, audit, clawDir, buildCancelledIntent(contractId, 'req-b', 'b'));

    const dir = path.join(clawDir, 'contract', 'lifecycle-intents', contractId);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(2);
  });
});

describe('readLifecycleIntent', () => {
  it('returns null for missing file', async () => {
    const result = await readLifecycleIntent(nodeFs, lifecycleIntentPath(clawDir, contractId, 'missing'));
    expect(result).toBeNull();
  });

  it('returns null for malformed json', async () => {
    const { audit } = makeAuditCapture();
    const intentPath = lifecycleIntentPath(clawDir, contractId, 'malformed');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(intentPath, '{broken', 'utf-8');

    const result = await readLifecycleIntent(nodeFs, intentPath);
    expect(result).toBeNull();
  });
});

describe('readLifecycleIntentsForContract', () => {
  it('returns all valid intents sorted by requested_at + request_id', async () => {
    const { audit } = makeAuditCapture();
    const intent1 = buildCancelledIntent(contractId, 'req-b', 'b');
    const intent2 = buildCompletedIntent(contractId, 'req-a', 'completion context');
    intent2.requested_at = '2026-07-27T00:00:00.000Z';
    intent1.requested_at = '2026-07-27T00:00:01.000Z';

    await persistLifecycleIntent(nodeFs, audit, clawDir, intent1);
    await persistLifecycleIntent(nodeFs, audit, clawDir, intent2);

    const { intents } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(intents.map(i => i.request_id)).toEqual(['req-a', 'req-b']);
  });

  it('reports malformed intent without hiding valid intents', async () => {
    const { audit, events } = makeAuditCapture();
    await persistLifecycleIntent(nodeFs, audit, clawDir, buildCancelledIntent(contractId, 'req-valid', 'ok'));
    const intentPath = lifecycleIntentPath(clawDir, contractId, 'req-bad');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(intentPath, JSON.stringify({ schema_version: 1, requested_state: 'unknown' }), 'utf-8');

    const { intents, issues } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(intents).toHaveLength(1);
    expect(intents[0].request_id).toBe('req-valid');
    expect(issues).toHaveLength(1);
    expect(issues[0].requestId).toBe('req-bad');
    expect(events.some(e => e.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE)).toBe(true);
  });

  it('reports identity mismatch', async () => {
    const { audit, events } = makeAuditCapture();
    const intentPath = lifecycleIntentPath(clawDir, contractId, 'req-wrong');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(
      intentPath,
      JSON.stringify({
        schema_version: 1,
        request_id: 'req-wrong',
        contract_id: 'other-contract',
        requested_state: 'cancelled',
        requested_at: new Date().toISOString(),
        reason: 'x',
      }),
      'utf-8',
    );

    const { intents, issues } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(intents).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toBe('identity_mismatch');
    expect(events.some(e => e.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE)).toBe(true);
  });

  it('returns empty result when no intent store exists', async () => {
    const { audit } = makeAuditCapture();
    const { intents, issues } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(intents).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });
});

describe('buildCorruptedIntent', () => {
  it('preserves typed corruption evidence', async () => {
    const { audit } = makeAuditCapture();
    const evidence = { reason: 'progress_schema_invalid' as const, relativePath: 'corrupted/progress.json' };
    const intent = buildCorruptedIntent(contractId, 'req-c', evidence);
    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);

    const { intents } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(intents).toHaveLength(1);
    expect(intents[0].requested_state).toBe('corrupted');
    expect((intents[0] as { evidence: { reason: string; relativePath: string } }).evidence.reason).toBe('progress_schema_invalid');
  });
});

describe('buildFailedIntent (Phase 1396 Step D)', () => {
  const failure = { reason: 'executor died', evidenceRef: 'executor/events.jsonl#seq=42', producer: 'event-loop' };

  it('persists and reads back the typed failure payload', async () => {
    const { audit } = makeAuditCapture();
    const intent = buildFailedIntent(contractId, 'req-f', failure);
    expect(intent.requested_state).toBe('failed');

    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);

    const { intents, issues } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(issues).toHaveLength(0);
    expect(intents).toHaveLength(1);
    expect(intents[0].requested_state).toBe('failed');
    expect((intents[0] as { failure: typeof failure }).failure).toEqual(failure);
  });

  it('is idempotent for identical failed payload with the same request id', async () => {
    const { audit, events } = makeAuditCapture();
    const intent = buildFailedIntent(contractId, 'req-f', failure);

    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);
    await persistLifecycleIntent(nodeFs, audit, clawDir, intent);

    const dir = path.join(clawDir, 'contract', 'lifecycle-intents', contractId);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(events.filter(e => e.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_PERSISTED)).toHaveLength(2);
  });

  it('rejects a failed intent without the failure payload as schema_invalid', async () => {
    const { audit, events } = makeAuditCapture();
    const intentPath = lifecycleIntentPath(clawDir, contractId, 'req-f-bad');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(
      intentPath,
      JSON.stringify({
        schema_version: 1,
        request_id: 'req-f-bad',
        contract_id: contractId,
        requested_state: 'failed',
        requested_at: new Date().toISOString(),
      }),
      'utf-8',
    );

    const { intents, issues } = await readLifecycleIntentsForContract(nodeFs, audit, clawDir, contractId);
    expect(intents).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toBe('schema_invalid');
    expect(events.some(e => e.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE)).toBe(true);
  });
});
