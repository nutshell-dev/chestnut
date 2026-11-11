import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import {
  ImportClaimEvidenceStore,
  ImportClaimStateError,
  observeImportReference,
  readImportClaim,
  type ImportClaimContext,
  type ProcessReferenceOps,
} from '../../src/cli/commands/claw-import-claim.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { decodeProcessRef } from '../../src/foundation/process-exec/index.js';
import type {
  ProcessEvidence,
  ProcessRef,
  ProcessRefDecode,
  ProcessRefObservation,
} from '../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../utils/temp.js';

const EVIDENCE: ProcessEvidence = {
  version: 1,
  atMs: 123,
  facts: [{ operation: 'test', outcome: { nested: [true, null, 'complete'] } }],
};
const REF = '{"version":0,"pid":42}' as ProcessRef;
const DECODED: ProcessRefDecode = { kind: 'decoded', value: REF };
const GONE: ProcessRefObservation = {
  kind: 'gone', reason: 'absent', evidence: EVIDENCE,
};
const ALIVE: ProcessRefObservation = { kind: 'alive', evidence: EVIDENCE };
const UNKNOWN: ProcessRefObservation = {
  kind: 'unknown', reason: 'query_failed', evidence: EVIDENCE,
};

const SOURCE = '/source/bundle';
const TARGET = 'nested/bundle';
let root: string;
let fs: NodeFileSystem;
let context: ImportClaimContext;
const claimRel = 'bundle/.import-claim';

beforeEach(async () => {
  root = await createTrackedTempDir('claw-import-claim-');
  fs = new NodeFileSystem({ baseDir: root });
  context = {
    source: SOURCE,
    target: TARGET,
    claimPath: path.join(root, claimRel),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

function store(): ImportClaimEvidenceStore {
  return new ImportClaimEvidenceStore(fs, context);
}

function writeClaim(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  nodeFs.mkdirSync(path.dirname(path.join(root, claimRel)), { recursive: true });
  nodeFs.writeFileSync(path.join(root, claimRel), raw);
  return raw;
}

function legacyClaim() {
  return {
    token: 'old-token',
    pid: 42,
    process_start_time: 'legacy start',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: SOURCE,
    target: TARGET,
    manifestHash: 'abc',
  };
}

function v1Claim() {
  return {
    schema_version: 1,
    token: 'new-token',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: SOURCE,
    target: TARGET,
    holder: { kind: 'captured', value: REF, evidence: EVIDENCE },
  };
}

function opsFor(observed: ProcessRefObservation): ProcessReferenceOps {
  return { decode: vi.fn().mockReturnValue(DECODED), inspect: vi.fn().mockReturnValue(observed) };
}

function readEvents(): Array<Record<string, unknown>> {
  const evidenceRoot = 'status/cli-import-claims';
  if (!nodeFs.existsSync(path.join(root, evidenceRoot))) return [];
  return fs.listSync(evidenceRoot, { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(entry => JSON.parse(fs.readSync(entry.path)) as Record<string, unknown>);
}

function catchState(fn: () => unknown): ImportClaimStateError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportClaimStateError);
    return error as ImportClaimStateError;
  }
  throw new Error('expected ImportClaimStateError');
}

describe('directory import claim reference observation', () => {
  it('passes a complete legacy v0 reference to L1 and preserves all returned facts', () => {
    const raw = writeClaim(legacyClaim());
    const ops = opsFor(GONE);
    const evidenceStore = store();

    expect(readImportClaim(fs, evidenceStore, claimRel, context, ops)).toMatchObject({ pid: 42 });
    expect(ops.decode).toHaveBeenCalledWith({ version: 0, pid: 42, startTime: 'legacy start' });
    expect(ops.inspect).toHaveBeenCalledWith(REF);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'holder_observed', raw, decoded: DECODED, observed: GONE, decision: 'eligible',
    });
    expect(events[0].observed).toEqual(GONE);
  });

  it('persists a complete v1 capture observation without interpreting OS fields in CLI', () => {
    const raw = writeClaim(v1Claim());
    const ops = opsFor(GONE);

    readImportClaim(fs, store(), claimRel, context, ops);

    expect(ops.decode).toHaveBeenCalledWith(REF);
    expect(readEvents()[0]).toMatchObject({
      kind: 'holder_observed', raw, decoded: DECODED, observed: GONE, decision: 'eligible',
    });
  });

  it.each([
    ['alive', ALIVE],
    ['unknown', UNKNOWN],
  ])('rejects an %s holder after durable observation and preserves original bytes', (_kind, observed) => {
    const raw = `{\n  "token": "old-token",\n  "pid": 42,\n  "createdAt": "2026-01-01T00:00:00.000Z",\n  "source": "${context.source}",\n  "target": "${context.target}"\n}`;
    writeClaim(raw);
    const evidenceStore = store();

    const error = catchState(() => readImportClaim(fs, evidenceStore, claimRel, context, opsFor(observed)));

    expect(error.published).toBe(false);
    expect(nodeFs.readFileSync(path.join(root, claimRel), 'utf8')).toBe(raw);
    expect(readEvents()[0]).toMatchObject({
      kind: 'holder_observed', raw, observed, decision: 'retain',
    });
  });

  it('retains invalid decode evidence and never inspects the process', () => {
    const raw = writeClaim(legacyClaim());
    const decoded: ProcessRefDecode = {
      kind: 'invalid', reason: 'invalid_v0_shape_or_pid', evidence: EVIDENCE,
    };
    const ops = { decode: vi.fn().mockReturnValue(decoded), inspect: vi.fn() };

    catchState(() => readImportClaim(fs, store(), claimRel, context, ops));

    expect(ops.inspect).not.toHaveBeenCalled();
    expect(readEvents()[0]).toMatchObject({
      kind: 'holder_observed', raw, decoded, decision: 'retain',
    });
  });
});

describe('directory import claim read rejection', () => {
  it.each([
    ['bad JSON', '{not json'],
    ['missing token', { ...legacyClaim(), token: '' }],
    ['wrong source', { ...legacyClaim(), source: '/another/source' }],
    ['invalid manifest', { ...legacyClaim(), manifestHash: 7 }],
    ['incomplete v1 holder', { ...v1Claim(), holder: { kind: 'unknown', evidence: EVIDENCE } }],
  ])('records and rejects %s without authorizing takeover', (_label, claim) => {
    const raw = writeClaim(claim);
    const ops = opsFor(GONE);

    catchState(() => readImportClaim(fs, store(), claimRel, context, ops));

    expect(nodeFs.readFileSync(path.join(root, claimRel), 'utf8')).toBe(raw);
    expect(readEvents()[0]).toMatchObject({ raw });
    expect(readEvents()[0].kind).toMatch(/^(claim_read_failed|holder_observed)$/);
  });

  it('rejects a missing legacy pid through the real L1 decoder', () => {
    const claim = legacyClaim() as Record<string, unknown>;
    delete claim.pid;
    const raw = writeClaim(claim);
    const inspect = vi.fn();

    catchState(() => readImportClaim(fs, store(), claimRel, context, {
      decode: decodeProcessRef,
      inspect,
    }));

    expect(inspect).not.toHaveBeenCalled();
    expect(readEvents()[0]).toMatchObject({
      kind: 'holder_observed', raw, decoded: { kind: 'invalid' }, decision: 'retain',
    });
  });

  it('never falls back to legacy pid for a future schema', () => {
    const raw = writeClaim({ ...legacyClaim(), schema_version: 99 });
    const ops = opsFor(GONE);

    const error = catchState(() => readImportClaim(fs, store(), claimRel, context, ops));

    expect(error.message).toContain('unsupported import claim schema: 99');
    expect(ops.decode).not.toHaveBeenCalled();
    expect(ops.inspect).not.toHaveBeenCalled();
    expect(nodeFs.readFileSync(path.join(root, claimRel), 'utf8')).toBe(raw);
    expect(readEvents()[0]).toMatchObject({ kind: 'claim_read_failed', raw });
  });

  it('preserves the original observation throw and both errors if recording also fails', () => {
    const raw = writeClaim(legacyClaim());
    const observationError = new Error('observer exploded');
    const persistenceError = new Error('disk exploded');
    const ops = {
      decode: vi.fn().mockReturnValue(DECODED),
      inspect: vi.fn().mockImplementation(() => { throw observationError; }),
    };
    const evidenceStore = store();
    vi.spyOn(fs, 'writeAtomicSync').mockImplementation(() => { throw persistenceError; });

    const error = catchState(() => readImportClaim(fs, evidenceStore, claimRel, context, ops));

    expect(error.originalError).toBe(observationError);
    expect(error.persistenceError).toBe(persistenceError);
    expect(error.pendingEvent).toMatchObject({ kind: 'claim_read_failed', raw });
    expect(nodeFs.readFileSync(path.join(root, claimRel), 'utf8')).toBe(raw);
  });
});

describe('ImportClaimEvidenceStore durability', () => {
  it('writes an index followed by complete sequence events', () => {
    const evidenceStore = store();

    const first = evidenceStore.append('self_capture', { capture: { kind: 'unknown', evidence: EVIDENCE } });
    const second = evidenceStore.append('claim_written', { exactRaw: 'raw bytes' });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(readEvents()).toEqual([first, second]);
    const index = JSON.parse(fs.readSync(`${evidenceStore.location}.json`)) as Record<string, unknown>;
    expect(index).toMatchObject({
      version: 1,
      attemptId: first.attemptId,
      source: context.source,
      target: context.target,
      recordDirectory: evidenceStore.location,
    });
  });

  it('retains the pending event and original error after directory failure', () => {
    const cause = Object.assign(new Error('mkdir failed'), { code: 'EIO' });
    vi.spyOn(fs, 'mkdirExclusiveSync').mockImplementation(() => { throw cause; });
    const evidenceStore = store();

    const error = catchState(() => evidenceStore.append('holder_observed', { raw: 'raw' }));

    expect(error.stage).toBe('claim_directory');
    expect(error.persistenceError).toBe(cause);
    expect(error.pendingEvent).toMatchObject({ kind: 'holder_observed', raw: 'raw' });
    expect(error.published).toBe(false);
  });

  it.each(['write_index', 'write_event'] as const)(
    'retains complete pending evidence after %s throw',
    stage => {
      const cause = new Error(`${stage} failed`);
      const evidenceStore = store();
      const target = stage === 'write_index' ? `${evidenceStore.location}.json` : `${evidenceStore.location}/000001.json`;
      const realWrite = fs.writeAtomicSync.bind(fs);
      vi.spyOn(fs, 'writeAtomicSync').mockImplementation((targetPath, content) => {
        if (targetPath === target) throw cause;
        return realWrite(targetPath, content);
      });

      const error = catchState(() => evidenceStore.append('holder_observed', {
        raw: 'raw', decoded: DECODED, observed: GONE,
      }));

      expect(error.stage).toBe(stage);
      expect(error.persistenceError).toBe(cause);
      expect(error.pendingEvent).toMatchObject({ raw: 'raw', decoded: DECODED, observed: GONE });
    },
  );

  it.each(['committed_platform_limited', 'committed_durability_unknown'] as const)(
    'does not rewrite or continue after a %s event',
    kind => {
      const durabilityError = new Error(kind);
      const result = { kind, error: durabilityError };
      const evidenceStore = store();
      const realWrite = fs.writeAtomicSync.bind(fs);
      const write = vi.spyOn(fs, 'writeAtomicSync').mockImplementation((targetPath, content) => {
        const actual = realWrite(targetPath, content);
        return targetPath.endsWith('000001.json') ? result : actual;
      });

      const error = catchState(() => evidenceStore.append('holder_observed', { raw: 'raw' }));

      expect(error.atomicResult).toBe(result);
      expect(error.persistenceError).toBe(durabilityError);
      expect(error.pendingEvent).toMatchObject({ raw: 'raw' });
      expect(write).toHaveBeenCalledTimes(2);
      expect(nodeFs.readFileSync(path.join(root, evidenceStore.location, '000001.json'), 'utf8'))
        .toBe(JSON.stringify(error.pendingEvent));
    },
  );

  it('propagates a non-durable holder observation instead of returning a recovery candidate', () => {
    const raw = writeClaim(legacyClaim());
    const result = {
      kind: 'committed_durability_unknown' as const,
      error: new Error('directory fsync failed'),
    };
    vi.spyOn(fs, 'writeAtomicSync').mockReturnValue(result);

    const error = catchState(() => readImportClaim(fs, store(), claimRel, context, opsFor(GONE)));

    expect(error.atomicResult).toBe(result);
    expect(error.pendingEvent).toMatchObject({ kind: 'holder_observed', raw, decision: 'eligible' });
    expect(nodeFs.readFileSync(path.join(root, claimRel), 'utf8')).toBe(raw);
  });
});

describe('observeImportReference', () => {
  it('derives eligibility only from gone and retains exact object references', () => {
    const ops = opsFor(UNKNOWN);

    const facts = observeImportReference('exact raw', { version: 0, pid: 42 }, ops);

    expect(facts.decoded).toBe(DECODED);
    expect(facts.observed).toBe(UNKNOWN);
    expect(facts).toEqual({
      raw: 'exact raw', decoded: DECODED, observed: UNKNOWN, decision: 'retain',
    });
  });
});
