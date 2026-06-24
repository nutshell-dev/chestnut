import { describe, it, expect } from 'vitest';

/**
 * phase 503: invariant test for foundation/uuid + foundation/hash owner module APIs.
 *
 * Asserts canonical exports exist. Renaming a function or removing
 * one breaks downstream callers and dual lint protection — this catches
 * the regression at test time.
 *
 * phase 574 扩 (phase 520-554 follow-up): 加 3 it block 覆盖新 owner module API:
 *   - core/claw-topology: MOTION_CLAW_ID + makeAgentDirResolver
 *   - cli/utils/claw-status-hints: 2 formatter
 *   - cli/utils/cli-commands: CLAW_VERBS + clawCmd + CONTRACT_COMMANDS
 */
describe('owner modules API presence (phase 503 / phase 574 expanded)', () => {
  it('foundation/uuid exposes newUuid, newShortUuid, randomHex', async () => {
    const uuidMod = await import('../../../src/foundation/uuid.js');
    expect(typeof uuidMod.newUuid).toBe('function');
    expect(typeof uuidMod.newShortUuid).toBe('function');
    expect(typeof uuidMod.randomHex).toBe('function');

    const id = uuidMod.newUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuidMod.newShortUuid().length).toBe(8);
    expect(uuidMod.newShortUuid(12).length).toBe(12);
    expect(uuidMod.randomHex(8).length).toBe(16);
  });

  it('foundation/hash exposes sha256Hex, sha256ShortHex, createSha256Hasher', async () => {
    const hashMod = await import('../../../src/foundation/hash.js');
    expect(typeof hashMod.sha256Hex).toBe('function');
    expect(typeof hashMod.sha256ShortHex).toBe('function');
    expect(typeof hashMod.createSha256Hasher).toBe('function');

    expect(hashMod.sha256Hex('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
    expect(hashMod.sha256ShortHex('test', 8)).toBe('9f86d081');

    const h = hashMod.createSha256Hasher();
    h.update('test');
    expect(h.digest()).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });

  // phase 574 扩: phase 520-554 引入新 owner module API invariant

  it('core/claw-topology exposes MOTION_CLAW_ID + makeAgentDirResolver (phase 520/535)', async () => {
    const topoMod = await import('../../../src/core/claw-topology/index.js');
    expect(typeof topoMod.MOTION_CLAW_ID).toBe('string');
    expect(topoMod.MOTION_CLAW_ID).toBe('motion');
    expect(typeof topoMod.makeAgentDirResolver).toBe('function');
    const resolver = topoMod.makeAgentDirResolver();
    expect(typeof resolver).toBe('function');
    // motion goes to subroot, others to claws/<id>
    expect(typeof resolver('motion')).toBe('string');
    expect(typeof resolver('other-claw')).toBe('string');
  });

  it('cli/utils/claw-status-hints exposes 2 formatter (phase 540/708)', async () => {
    const hintsMod = await import('../../../src/cli/utils/claw-status-hints.js');
    expect(typeof hintsMod.formatClawStatusHint).toBe('function');
    expect(typeof hintsMod.formatNoActiveContractHint).toBe('function');
    expect(hintsMod.formatClawStatusHint('x', true)).toBeUndefined();
    expect(hintsMod.formatClawStatusHint('x', false)).toMatch(/chestnut claw x daemon/);
    expect(hintsMod.formatNoActiveContractHint('x', true)).toBeUndefined();
    expect(hintsMod.formatNoActiveContractHint('x', false)).toMatch(/No active contract for "x"/);
  });

  it('cli/utils/cli-commands exposes CLAW_VERBS + clawCmd + CONTRACT_COMMANDS (phase 554/708)', async () => {
    const cmdMod = await import('../../../src/cli/utils/cli-commands.js');
    expect(typeof cmdMod.CLAW_VERBS).toBe('object');
    expect(cmdMod.CLAW_VERBS.CHAT).toBe('chat');
    expect(cmdMod.CLAW_VERBS.STOP).toBe('stop');
    expect(typeof cmdMod.clawCmd).toBe('function');
    expect(cmdMod.clawCmd('myclaw', cmdMod.CLAW_VERBS.CHAT)).toBe('chestnut claw myclaw chat');
    expect(typeof cmdMod.CONTRACT_COMMANDS).toBe('object');
    expect(cmdMod.CONTRACT_COMMANDS.SHOW).toBe('chestnut contract show');
  });
});
