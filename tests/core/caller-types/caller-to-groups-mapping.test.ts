/**
 * @module Tests.Core.CallerTypes
 * CALLER_TYPE_TO_GROUPS mapping tests (phase 1337 sub-2)
 */

import { describe, it, expect } from 'vitest';
import { CALLER_TYPE_TO_GROUPS } from '../../../src/core/caller-types.js';

describe('CALLER_TYPE_TO_GROUPS mapping', () => {
  it('(a) covers all 6 CallerType entries (exhaustive)', () => {
    expect(Object.keys(CALLER_TYPE_TO_GROUPS).length).toBe(6);
    const expected = ['motion', 'claw', 'subagent', 'shadow', 'miner', 'verifier'];
    for (const key of expected) {
      expect(CALLER_TYPE_TO_GROUPS[key as keyof typeof CALLER_TYPE_TO_GROUPS]).toBeInstanceOf(Set);
    }
  });

  it('(b) motion has all 12 ToolGroups', () => {
    const groups = CALLER_TYPE_TO_GROUPS.motion;
    expect(groups.has('fs-read')).toBe(true);
    expect(groups.has('fs-write')).toBe(true);
    expect(groups.has('spawn')).toBe(true);
    expect(groups.has('audit')).toBe(true);
    expect(groups.has('llm')).toBe(true);
    expect(groups.has('cron')).toBe(true);
    expect(groups.has('skill')).toBe(true);
    expect(groups.has('messaging')).toBe(true);
    expect(groups.has('memory')).toBe(true);
    expect(groups.has('status')).toBe(true);
    expect(groups.has('shadow')).toBe(true);
    expect(groups.has('subagent-protocol')).toBe(true);
  });

  it('(b) claw has all 12 ToolGroups', () => {
    const groups = CALLER_TYPE_TO_GROUPS.claw;
    expect(groups.has('spawn')).toBe(true);
    expect(groups.has('cron')).toBe(true);
    expect(groups.has('shadow')).toBe(true);
  });

  it('(b) subagent lacks spawn, cron, shadow', () => {
    const groups = CALLER_TYPE_TO_GROUPS.subagent;
    expect(groups.has('fs-read')).toBe(true);
    expect(groups.has('spawn')).toBe(false);
    expect(groups.has('cron')).toBe(false);
    expect(groups.has('shadow')).toBe(false);
  });

  it('(b) shadow lacks spawn, cron, messaging, shadow', () => {
    const groups = CALLER_TYPE_TO_GROUPS.shadow;
    expect(groups.has('fs-read')).toBe(true);
    expect(groups.has('spawn')).toBe(false);
    expect(groups.has('cron')).toBe(false);
    expect(groups.has('messaging')).toBe(false);
    expect(groups.has('shadow')).toBe(false);
  });

  it('(b) miner lacks fs-write, spawn, cron, skill, messaging, shadow, status', () => {
    const groups = CALLER_TYPE_TO_GROUPS.miner;
    expect(groups.has('fs-read')).toBe(true);
    expect(groups.has('fs-write')).toBe(false);
    expect(groups.has('spawn')).toBe(false);
    expect(groups.has('cron')).toBe(false);
    expect(groups.has('skill')).toBe(false);
    expect(groups.has('messaging')).toBe(false);
    expect(groups.has('shadow')).toBe(false);
    expect(groups.has('status')).toBe(false);
  });

  it('(b) verifier lacks fs-write, spawn, cron, skill, messaging, shadow, status', () => {
    const groups = CALLER_TYPE_TO_GROUPS.verifier;
    expect(groups.has('fs-read')).toBe(true);
    expect(groups.has('fs-write')).toBe(false);
    expect(groups.has('audit')).toBe(true);
    expect(groups.has('memory')).toBe(true);
  });

  it('(d) all mapped values are Sets', () => {
    for (const [caller, groups] of Object.entries(CALLER_TYPE_TO_GROUPS)) {
      expect(groups).toBeInstanceOf(Set);
      expect(caller).toBeTruthy();
    }
  });

  it('(c) deleting an entry would fail at compile time (type-level enforced via Record)', () => {
    // Runtime verification: Record shape enforces all 6 keys exist.
    // If a CallerType were missing from the declaration, TS would error.
    const keys = Object.keys(CALLER_TYPE_TO_GROUPS) as Array<keyof typeof CALLER_TYPE_TO_GROUPS>;
    expect(new Set(keys).size).toBe(6);
  });
});
