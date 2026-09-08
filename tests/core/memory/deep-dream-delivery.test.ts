/**
 * Phase 1162 Step D — Deep Dream durable notification delivery.
 *
 * Coverage:
 * - startup recovery of pending notifications
 * - stage save failure prevents send and preserves prior state
 * - send rejection retains pending body byte-for-byte
 * - query failure retains pending and stops the claw
 * - dedup against pending/inflight/done clears pending without resend
 * - failed messages still trigger a new send
 * - confirm save failure leaves disk pending; next run dedups
 * - multi-claw isolation: deferred claw A does not block claw B
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
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
import { InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';

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

describe('deep-dream durable delivery (phase 1162 Step D)', () => {
  let chestnutDir: string;
  let topology: ClawTopology;
  let audit: ReturnType<typeof makeMockAudit>;
  let notifyClaw: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    chestnutDir = await createTempDir();
    topology = createClawTopology({
      fs: new NodeFileSystem({ baseDir: chestnutDir }),
      chestnutRoot: chestnutDir,
      motionClawId: makeClawId('motion'),
      motionDir: 'motion',
    });
    audit = makeMockAudit();
    notifyClaw = vi.fn().mockResolvedValue(undefined);
    mockLlmCall.mockReset();
    mockLlmCall.mockResolvedValue(makeTextResponse('dream output'));
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
      notifyClaw,
      ...opts,
    });
  }

  async function makeClaw(clawId: string) {
    const clawDir = path.join(chestnutDir, 'claws', clawId);
    const archiveDir = path.join(clawDir, 'dialog', 'archive');
    const inboxDir = path.join(clawDir, 'inbox', 'pending');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(inboxDir, { recursive: true });
    return { clawDir, archiveDir, inboxDir };
  }

  async function writeArchive(archiveDir: string, filename: string, session: string) {
    await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');
  }

  function readState(clawDir: string) {
    const statePath = path.join(clawDir, '.deep-dream-state.json');
    return JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
  }

  it('startup recovery flushes pre-existing pending then processes new session', async () => {
    const { clawDir, archiveDir } = await makeClaw('claw-a');
    const pendingBody = 'recovered pending body';
    await fs.writeFile(path.join(clawDir, '.deep-dream-state.json'), JSON.stringify({
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
      pendingNotifications: [{
        deliveryId: 'deep-dream:claw-a:0:none:recoveredhash',
        body: pendingBody,
        sessionCount: 1,
        createdAt: 1717000000000,
      }],
    }), 'utf-8');

    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    await run();

    // Recovered then new: 2 calls total.
    expect(notifyClaw).toHaveBeenCalledTimes(2);
    const bodies = notifyClaw.mock.calls.map((c: any) => c[1].body);
    expect(bodies).toContain(pendingBody);
    expect(bodies.some((b: string) => b.includes('dream output'))).toBe(true);

    const state = readState(clawDir);
    expect(state.pendingNotifications).toEqual([]);
  });

  it('stage save failure prevents notify and preserves prior disk state', async () => {
    const { clawDir, archiveDir } = await makeClaw('claw-a');
    await fs.writeFile(path.join(clawDir, '.deep-dream-state.json'), JSON.stringify({
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
      pendingNotifications: [],
    }), 'utf-8');

    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    const originalWriteAtomicSync = NodeFileSystem.prototype.writeAtomicSync;
    const writeSpy = vi.spyOn(NodeFileSystem.prototype, 'writeAtomicSync').mockImplementation(function (this: NodeFileSystem, p: string, content: string) {
      if (p === '.deep-dream-state.json') {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return originalWriteAtomicSync.call(this, p, content);
    });

    await run();

    // State save failed → notify must not run (no flush).
    expect(notifyClaw).not.toHaveBeenCalled();

    // Prior disk state preserved (no partial overwrite).
    const state = readState(clawDir);
    expect(state.lastProcessedDeepDreamAt).toBe(0);
    expect(state.pendingNotifications).toEqual([]);

    writeSpy.mockRestore();
  });

  it('send rejection retains pending body byte-for-byte', async () => {
    const { clawDir, archiveDir } = await makeClaw('claw-a');
    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    const dreamOutput = 'will be retained exactly';
    notifyClaw.mockRejectedValueOnce(new Error('target inbox unreachable'));

    mockLlmCall.mockResolvedValueOnce(makeTextResponse(dreamOutput));

    await run();

    expect(notifyClaw).toHaveBeenCalledTimes(1);
    const sentBody = notifyClaw.mock.calls[0][1].body as string;
    expect(sentBody).toContain(dreamOutput);

    const state = readState(clawDir);
    expect(state.pendingNotifications).toHaveLength(1);
    // Pending body must be byte-for-byte identical to what was sent.
    expect(state.pendingNotifications[0].body).toBe(sentBody);
  });

  it('query failure retains pending and stops the claw', async () => {
    const { clawDir, archiveDir, inboxDir } = await makeClaw('claw-a');
    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    // Make inbox unreadable so findByExtraMeta throws.
    await fs.chmod(inboxDir, 0o000);

    await run();

    // Query failed before send.
    expect(notifyClaw).not.toHaveBeenCalled();

    const state = readState(clawDir);
    expect(state.pendingNotifications).toHaveLength(1);

    await fs.chmod(inboxDir, 0o755);
  });

  it('pre-existing done message clears pending without resend', async () => {
    const { clawDir, archiveDir, inboxDir } = await makeClaw('claw-a');
    const deliveryId = 'deep-dream:claw-a:0:none:deduphash';
    const pendingBody = 'already done body';

    // Seed a done message with matching delivery_id.
    const writer = (InboxWriter as any).__internal_create(new NodeFileSystem({ baseDir: clawDir }), makeInboxPath(inboxDir.replace('/pending', '/done')), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
    writer.writeSync({
      type: 'deep_dream',
      source: 'cron-dream',
      priority: 'low',
      body: pendingBody,
      extraFields: { delivery_id: deliveryId, session_count: '1' },
    });

    await fs.writeFile(path.join(clawDir, '.deep-dream-state.json'), JSON.stringify({
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
      pendingNotifications: [{
        deliveryId,
        body: pendingBody,
        sessionCount: 1,
        createdAt: 1717000000000,
      }],
    }), 'utf-8');

    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    await run();

    // Dedup: no resend for recovered pending.
    expect(notifyClaw).toHaveBeenCalledTimes(1);
    const newBody = notifyClaw.mock.calls[0][1].body as string;
    expect(newBody).not.toBe(pendingBody);

    const state = readState(clawDir);
    expect(state.pendingNotifications).toEqual([]);
  });

  it('pre-existing failed message still triggers a new send', async () => {
    const { clawDir, archiveDir, inboxDir } = await makeClaw('claw-a');
    const deliveryId = 'deep-dream:claw-a:0:none:failedhash';
    const pendingBody = 'failed but retried body';

    const writer = (InboxWriter as any).__internal_create(new NodeFileSystem({ baseDir: clawDir }), makeInboxPath(inboxDir.replace('/pending', '/failed')), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
    writer.writeSync({
      type: 'deep_dream',
      source: 'cron-dream',
      priority: 'low',
      body: pendingBody,
      extraFields: { delivery_id: deliveryId, session_count: '1' },
    });

    await fs.writeFile(path.join(clawDir, '.deep-dream-state.json'), JSON.stringify({
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
      pendingNotifications: [{
        deliveryId,
        body: pendingBody,
        sessionCount: 1,
        createdAt: 1717000000000,
      }],
    }), 'utf-8');

    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    await run();

    // Failed pending triggers a resend plus the new archive also sends.
    expect(notifyClaw).toHaveBeenCalledTimes(2);
    const bodies = notifyClaw.mock.calls.map((c: any) => c[1].body);
    expect(bodies).toContain(pendingBody);

    const state = readState(clawDir);
    expect(state.pendingNotifications).toEqual([]);
  });

  it('confirm save failure leaves disk pending; next run dedups without duplicate send', async () => {
    const { clawDir, archiveDir, inboxDir } = await makeClaw('claw-a');
    await writeArchive(archiveDir, '1000000000000_abcd1234.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    let saveCount = 0;
    const originalWriteAtomicSync = NodeFileSystem.prototype.writeAtomicSync;
    const writeSpy = vi.spyOn(NodeFileSystem.prototype, 'writeAtomicSync').mockImplementation(function (this: NodeFileSystem, p: string, content: string) {
      if (p === '.deep-dream-state.json') {
        saveCount++;
        if (saveCount === 2) {
          // Stage save succeeds; confirm save after notify fails.
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
      }
      return originalWriteAtomicSync.call(this, p, content);
    });

    await run();

    // First run: send happened, confirm save failed.
    expect(notifyClaw).toHaveBeenCalledTimes(1);

    const stateAfterFail = readState(clawDir);
    expect(stateAfterFail.pendingNotifications).toHaveLength(1);

    // Manually write the message to inbox as if it succeeded externally,
    // to simulate next-run dedup.
    const writer = (InboxWriter as any).__internal_create(new NodeFileSystem({ baseDir: clawDir }), makeInboxPath(inboxDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
    writer.writeSync({
      type: 'deep_dream',
      source: 'cron-dream',
      priority: 'low',
      body: stateAfterFail.pendingNotifications[0].body,
      extraFields: {
        delivery_id: stateAfterFail.pendingNotifications[0].deliveryId,
        session_count: String(stateAfterFail.pendingNotifications[0].sessionCount),
      },
    });

    notifyClaw.mockClear();
    saveCount = 0;

    // Second run: no new archives, so only recovery.
    await run();

    // Dedup: no new send.
    expect(notifyClaw).not.toHaveBeenCalled();
    const stateAfterRecovery = readState(clawDir);
    expect(stateAfterRecovery.pendingNotifications).toEqual([]);

    writeSpy.mockRestore();
  });

  it('claw A deferred does not block claw B from completing', async () => {
    const clawA = await makeClaw('claw-a');
    const clawB = await makeClaw('claw-b');

    // claw-a: existing pending + unreadable inbox → deferred at recovery.
    await fs.writeFile(path.join(clawA.clawDir, '.deep-dream-state.json'), JSON.stringify({
      lastProcessedDeepDreamAt: 0,
      currentSessionDreamedDate: '',
      pendingNotifications: [{
        deliveryId: 'deep-dream:claw-a:0:none:ahash',
        body: 'a-pending',
        sessionCount: 1,
        createdAt: 1717000000000,
      }],
    }), 'utf-8');
    await fs.chmod(clawA.inboxDir, 0o000);

    await writeArchive(clawB.archiveDir, '1000000000000_bbbb0000.json', makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]));

    await run();

    // claw-a deferred, claw-b completed.
    expect(notifyClaw).toHaveBeenCalledTimes(1);
    expect(notifyClaw.mock.calls[0][0]).toBe('claw-b');

    const stateA = readState(clawA.clawDir);
    expect(stateA.pendingNotifications).toHaveLength(1);

    const stateB = readState(clawB.clawDir);
    expect(stateB.pendingNotifications).toEqual([]);

    await fs.chmod(clawA.inboxDir, 0o755);
  });
});
