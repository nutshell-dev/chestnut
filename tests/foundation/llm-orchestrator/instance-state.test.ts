import { afterEach, describe, expect, it } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AtomicWriteResult, FileSystem } from '../../../src/foundation/fs/index.js';
import {
  createEmptyLLMInstanceState,
  LLM_INSTANCE_STATE_FILE,
  loadLLMInstanceState,
  saveLLMInstanceState,
  type LLMInstanceStateV1,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

async function fixture() {
  const dir = await createTrackedTempDir('instance-state-');
  dirs.push(dir);
  return { dir, fs: new NodeFileSystem({ baseDir: dir }) };
}

function validState(): LLMInstanceStateV1 {
  return {
    schema_version: 1,
    revision: 2,
    updatedAt: '2026-11-01T00:00:00.000Z',
    providers: [{
      providerId: 'provider-a',
      breaker: { state: 'open', consecutiveFailures: 2, openedAtMs: 10, lastFailureClass: 'transient' },
      sharedFailure: { errorClass: 'transient', floorMs: 20, epoch: 1 },
    }],
    lastSuccess: { providerId: 'provider-a' },
  };
}

describe('LLM instance state V1', () => {
  it('treats a missing file as empty and round-trips valid state', async () => {
    const { dir, fs } = await fixture();
    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'missing' });
    expect(createEmptyLLMInstanceState()).toMatchObject({ schema_version: 1, revision: 0, providers: [] });
    expect(saveLLMInstanceState(fs, validState()).kind).toBe('durable');
    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'ok', state: validState() });
    expect(fsNative.existsSync(path.join(dir, 'status', LLM_INSTANCE_STATE_FILE))).toBe(true);
  });

  it('uses an explicitly injected state directory', async () => {
    const { dir, fs } = await fixture();
    saveLLMInstanceState(fs, validState(), 'custom-status');
    expect(fsNative.existsSync(path.join(dir, 'custom-status', LLM_INSTANCE_STATE_FILE))).toBe(true);
    expect(loadLLMInstanceState(fs, 'custom-status').kind).toBe('ok');
  });

  it('preserves the atomic write three-state result', async () => {
    const { fs } = await fixture();
    const outcomes: AtomicWriteResult[] = [
      { kind: 'durable' },
      { kind: 'committed_platform_limited', error: new Error('limited') },
      { kind: 'committed_durability_unknown', error: new Error('unknown') },
    ];
    for (const outcome of outcomes) {
      const wrapped = new Proxy(fs, {
        get(target, prop, receiver) {
          if (prop === 'writeAtomicSync') return () => outcome;
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileSystem;
      expect(saveLLMInstanceState(wrapped, validState())).toBe(outcome);
    }
  });

  it('rejects corrupt or unknown-schema input without rewriting it', async () => {
    const { dir, fs } = await fixture();
    const file = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
    fsNative.mkdirSync(path.dirname(file), { recursive: true });
    for (const [raw, reason] of [
      ['{bad json', 'parse_failed'],
      [JSON.stringify({ ...validState(), schema_version: 2 }), 'schema_invalid'],
    ] as const) {
      fsNative.writeFileSync(file, raw);
      expect(loadLLMInstanceState(fs)).toMatchObject({ kind: 'unusable', reason });
      expect(fsNative.readFileSync(file, 'utf8')).toBe(raw);
    }
  });

  it('strictly rejects invalid numbers, times and cross-field identities', async () => {
    const { dir, fs } = await fixture();
    const file = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
    fsNative.mkdirSync(path.dirname(file), { recursive: true });
    const invalid = [
      { ...validState(), revision: -1 },
      { ...validState(), updatedAt: 'not-a-time' },
      { ...validState(), providers: [validState().providers[0], validState().providers[0]] },
      { ...validState(), providers: [{ ...validState().providers[0], breaker: { state: 'open', consecutiveFailures: 1, lastFailureClass: 'transient' } }] },
      { ...validState(), lastSuccess: { providerId: 'missing' } },
      { ...validState(), providers: [{ ...validState().providers[0], sharedFailure: { errorClass: 'transient', epoch: Number.NaN } }] },
    ];
    for (const state of invalid) {
      const raw = JSON.stringify(state);
      fsNative.writeFileSync(file, raw);
      expect(loadLLMInstanceState(fs)).toMatchObject({ kind: 'unusable', reason: 'schema_invalid' });
      expect(fsNative.readFileSync(file, 'utf8')).toBe(raw);
    }
  });
});
