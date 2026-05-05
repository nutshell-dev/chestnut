/**
 * Tool profiles tests
 */
import { describe, it, expect } from 'vitest';
import { TOOL_PROFILES } from '../../src/foundation/tools/profiles.js';

describe('Tool Profiles', () => {
  it('should have correct tools in each profile', () => {
    expect(TOOL_PROFILES.full).toContain('dispatch');
    expect(TOOL_PROFILES.full).toContain('spawn');
    expect(TOOL_PROFILES.full).toContain('skill');

    expect(TOOL_PROFILES.readonly).not.toContain('write');
    expect(TOOL_PROFILES.readonly).not.toContain('spawn');

    expect(TOOL_PROFILES.subagent).not.toContain('spawn');
    expect(TOOL_PROFILES.subagent).not.toContain('send');

    expect(TOOL_PROFILES.dream).not.toContain('write');
    expect(TOOL_PROFILES.dream).not.toContain('spawn');

    expect(TOOL_PROFILES.subagent).toContain('edit');
    expect(TOOL_PROFILES.subagent).toContain('multi_edit');
    expect(TOOL_PROFILES.miner).toContain('edit');
    expect(TOOL_PROFILES.miner).toContain('multi_edit');

    expect(TOOL_PROFILES.full).not.toContain('edit');
    expect(TOOL_PROFILES.full).not.toContain('multi_edit');
    expect(TOOL_PROFILES.readonly).not.toContain('edit');
    expect(TOOL_PROFILES.readonly).not.toContain('multi_edit');
    expect(TOOL_PROFILES.dream).not.toContain('edit');
    expect(TOOL_PROFILES.dream).not.toContain('multi_edit');
    expect(TOOL_PROFILES.verifier).not.toContain('edit');
    expect(TOOL_PROFILES.verifier).not.toContain('multi_edit');
  });
});
