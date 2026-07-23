/**
 * Phase 1161 — Deep Dream future schema fail-closed propagation.
 *
 * Run-level regression: future state must block only the owning claw before
 * any discovery/LLM/output/save side effects, preserve the file byte-for-byte,
 * and leave other claws unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { runDeepDream } from '../../../src/core/memory/deep-dream.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import { makeMockAudit } from '../../helpers/audit.js';

// ─── LLMOrchestrator mock ──────────────────────────────────────────

const mockLlmCall = vi.fn();

const mockLlmService = {
  call: mockLlmCall,
  stream: vi.fn(),
  healthCheck: vi.fn(),
  getProviderInfo: vi.fn(),
  close: vi.fn(),
};

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function makeSessionJson(messages: Array<{ role: string; content: string }>) {
  return JSON.stringify({ messages });
}

const fakeLlmConfig: LLMOrchestratorConfig = {
  primary: { name: 'test', apiKey: 'sk-test', model: 'claude-test' } as any,
};

const clawFsFactory = (clawDir: string): FileSystem => new NodeFileSystem({ baseDir: clawDir });
const mockNotifyClaw = vi.fn().mockResolvedValue(undefined);

// ─── 测试 ─────────────────────────────────────────────────────

describe('deep-dream future schema fail-closed (phase 1161)', () => {
  let chestnutDir: string;
  let topology: ClawTopology;
  let audit: ReturnType<typeof makeMockAudit>;

  beforeEach(async () => {
    chestnutDir = await createTempDir();
    topology = createClawTopology({
      fs: new NodeFileSystem({ baseDir: chestnutDir }),
      chestnutRoot: chestnutDir,
      motionClawId: makeClawId('motion'),
      motionDir: 'motion',
    });
    audit = makeMockAudit();
    mockLlmCall.mockReset();
    mockLlmCall.mockResolvedValue(makeTextResponse('dream output'));
    mockNotifyClaw.mockClear();
  });

  afterEach(async () => {
    await cleanupTempDir(chestnutDir);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function run(opts: Partial<Parameters<typeof runDeepDream>[0]> = {}) {
    return runDeepDream({
      clawsDir: `${chestnutDir}/claws`,
      clawTopology: topology,
      llmConfig: fakeLlmConfig,
      llmService: mockLlmService as any,
      fs: new NodeFileSystem({ baseDir: chestnutDir }),
      audit,
      clawFsFactory,
      notifyClaw: mockNotifyClaw,
      ...opts,
    });
  }

  it('future schema blocks the claw with zero side effects', async () => {
    const clawDir = path.join(chestnutDir, 'claws', 'claw-a');
    const archiveDir = path.join(clawDir, 'dialog', 'archive');
    const inboxDir = path.join(clawDir, 'inbox', 'pending');
    const statePath = path.join(clawDir, '.deep-dream-state.json');
    const motionDir = path.join(chestnutDir, 'motion');

    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(inboxDir, { recursive: true });

    const futureState = JSON.stringify({
      schema_version: 99,
      lastProcessedDeepDreamAt: 12345,
      currentSessionDreamedDate: '2099-01-01',
      futureField: 'should-be-preserved',
    }, null, 2);
    await fs.writeFile(statePath, futureState, 'utf-8');

    // An archive exists, but the claw must not process it.
    const filename = `1000000000000_abcd1234.json`;
    await fs.writeFile(
      path.join(archiveDir, filename),
      makeSessionJson([
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'done' },
      ]),
      'utf-8',
    );

    await run({ motionFs: new NodeFileSystem({ baseDir: motionDir }) });

    // Future file byte-for-byte unchanged.
    expect(fsSync.readFileSync(statePath, 'utf8')).toBe(futureState);

    // No LLM calls for the blocked claw.
    expect(mockLlmCall).not.toHaveBeenCalled();

    // No inbox write.
    expect(fsSync.readdirSync(inboxDir)).toHaveLength(0);

    // No motion output write.
    const motionOutputDir = path.join(motionDir, 'memory', 'dream-outputs');
    expect(fsSync.existsSync(motionOutputDir)).toBe(false);

    // Diagnostic audit from loader.
    expect(audit.write).toHaveBeenCalledWith(
      MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION,
      'version=99',
      'current=2',
      'clawId=claw-a',
      'reason=cannot_migrate_future_version',
    );

    // Job-level blocked audit.
    expect(audit.write).toHaveBeenCalledWith(
      MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      'step=blocked',
      'clawId=claw-a',
      'reason=future_schema',
      'version=99',
    );
  });

  it('future schema on one claw does not block another claw', async () => {
    const makeClaw = async (clawId: string) => {
      const clawDir = path.join(chestnutDir, 'claws', clawId);
      await fs.mkdir(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
      await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
      return clawDir;
    };

    const clawA = await makeClaw('claw-a');
    const clawB = await makeClaw('claw-b');

    const futureState = JSON.stringify({
      schema_version: 99,
      lastProcessedDeepDreamAt: 12345,
      currentSessionDreamedDate: '2099-01-01',
    }, null, 2);
    const aStatePath = path.join(clawA, '.deep-dream-state.json');
    await fs.writeFile(aStatePath, futureState, 'utf-8');

    const bArchive = `1000000000000_bbbb0000.json`;
    await fs.writeFile(
      path.join(clawB, 'dialog', 'archive', bArchive),
      makeSessionJson([
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'done' },
      ]),
      'utf-8',
    );

    await run();

    // claw-a: future file unchanged, no state save, no inbox, no LLM.
    expect(fsSync.readFileSync(aStatePath, 'utf8')).toBe(futureState);
    expect(fsSync.readdirSync(path.join(clawA, 'inbox', 'pending'))).toHaveLength(0);

    // claw-b: processed, state updated, inbox written.
    const bStatePath = path.join(clawB, '.deep-dream-state.json');
    const bState = JSON.parse(fsSync.readFileSync(bStatePath, 'utf-8'));
    expect(bState.lastProcessedDeepDreamAt).toBeGreaterThanOrEqual(parseInt(bArchive.split('_')[0], 10));

    const bInboxFiles = fsSync.readdirSync(path.join(clawB, 'inbox', 'pending'));
    expect(bInboxFiles.length).toBeGreaterThan(0);
    const bInbox = fsSync.readFileSync(path.join(clawB, 'inbox', 'pending', bInboxFiles[0]), 'utf8');
    expect(bInbox).toContain('type: deep_dream');

    // Only claw-b triggered LLM calls (2 per archive).
    expect(mockLlmCall).toHaveBeenCalledTimes(2);

    // Blocked audit for claw-a only.
    expect(audit.write).toHaveBeenCalledWith(
      MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      'step=blocked',
      'clawId=claw-a',
      'reason=future_schema',
      'version=99',
    );

    // claw-b finished normally.
    expect(audit.write).toHaveBeenCalledWith(
      MEMORY_AUDIT_EVENTS.DEEP_DREAM_JOB,
      'step=finished',
      'clawId=claw-b',
      expect.stringMatching(/^dream_count=/),
    );
  });
});
