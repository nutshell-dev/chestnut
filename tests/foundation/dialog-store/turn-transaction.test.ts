/**
 * DialogStore turn transaction (beginTurn/commitTurn/rollbackTurn)
 * Phase 1285 reverse tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';

describe('DialogStore turn transaction (phase 1285)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: DialogStore;
  const filename = 'current.json';
  const clawId = 'test-claw';

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    store = new DialogStore(fs, '', audit.audit, filename, clawId);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('beginTurn captures snapshot and emits TURN_BEGIN', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }], toolsForLLM: [] });
    await store.beginTurn();

    const beginEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_BEGIN);
    expect(beginEvents).toHaveLength(1);
  });

  it('commitTurn clears snapshot and emits TURN_COMMIT', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }], toolsForLLM: [] });
    await store.beginTurn();
    await store.commitTurn();

    const commitEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_COMMIT);
    expect(commitEvents).toHaveLength(1);
  });

  it('rollbackTurn restores pre-turn state and emits TURN_ROLLBACK', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }], toolsForLLM: [] });
    await store.beginTurn();

    // Append mid-turn message
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], toolsForLLM: [] });

    await store.rollbackTurn('user_interrupt');

    const { session } = await store.load();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('hi');

    const rollbackEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_ROLLBACK);
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0].some(c => c.includes('reason=user_interrupt'))).toBe(true);
  });

  it('save during transaction still writes current.json incrementally', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }], toolsForLLM: [] });
    await store.beginTurn();
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'mid' }], toolsForLLM: [] });

    // current.json should reflect mid-turn state
    const { session } = await store.load();
    expect(session.messages).toHaveLength(2);
  });

  it('rollbackTurn without beginTurn is no-op', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }], toolsForLLM: [] });
    await store.rollbackTurn('test');

    const { session } = await store.load();
    expect(session.messages).toHaveLength(1);

    const rollbackEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_ROLLBACK);
    expect(rollbackEvents).toHaveLength(0);
  });

  it('new process rolls an open transaction back to the last complete session', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'complete' }], toolsForLLM: [] });
    await store.beginTurn();
    await store.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'complete' }, { role: 'assistant', content: 'partial' }],
      toolsForLLM: [],
    });

    const restarted = new DialogStore(fs, '', audit.audit, filename, clawId);
    const result = await restarted.load();

    expect(result.source).toBe('current');
    if (result.source !== 'current') throw new Error(`unexpected source ${result.source}`);
    expect(result.session.messages).toEqual([{ role: 'user', content: 'complete' }]);
    await expect(fs.read('turn-transaction.json')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
    expect(audit.events).toContainEqual(expect.arrayContaining([
      DIALOG_AUDIT_EVENTS.TURN_RECOVERED,
      expect.stringMatching(/^transaction_id=/),
      'action=rollback_open',
    ]));
  });

  it('new process retains a committed turn when decision-record cleanup previously failed', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'user', content: 'complete' }], toolsForLLM: [] });
    await store.beginTurn();
    await store.save({
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'complete' }, { role: 'assistant', content: 'committed' }],
      toolsForLLM: [],
    });
    const deleteSpy = vi.spyOn(fs, 'delete').mockRejectedValueOnce(new Error('cleanup unavailable'));
    await store.commitTurn();
    deleteSpy.mockRestore();

    const restarted = new DialogStore(fs, '', audit.audit, filename, clawId);
    const result = await restarted.load();

    expect(result.source).toBe('current');
    if (result.source !== 'current') throw new Error(`unexpected source ${result.source}`);
    expect(result.session.messages.at(-1)?.content).toBe('committed');
    await expect(fs.read('turn-transaction.json')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
    expect(audit.events).toContainEqual(expect.arrayContaining([
      DIALOG_AUDIT_EVENTS.TURN_RECOVERED,
      expect.stringMatching(/^transaction_id=/),
      'action=retain_committed',
    ]));
  });

  it('malformed transaction record fails closed without reading partial current as authoritative', async () => {
    await store.save({ systemPrompt: 'sp', messages: [{ role: 'assistant', content: 'partial' }], toolsForLLM: [] });
    await fs.writeAtomic('turn-transaction.json', '{broken');

    const restarted = new DialogStore(fs, '', audit.audit, filename, clawId);
    const result = await restarted.load();

    expect(result.source).toBe('io_error');
    expect(audit.events.some(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_RECOVERY_FAILED)).toBe(true);
  });
});
