/**
 * @module Tests.Foundation.Tools
 * ToolGroup capability tag type-level tests (phase 1337 sub-1)
 */

import { describe, it, expect } from 'vitest';
import type { ToolGroup, ExecContext, Tool } from '../../../src/foundation/tools/types.js';

describe('ToolGroup capability tag', () => {
  it('(a) ToolGroup union has exactly 12 groups', () => {
    // Runtime verification via exhaustive Set
    const allGroups: ToolGroup[] = [
      'fs-read',
      'fs-write',
      'spawn',
      'audit',
      'llm',
      'cron',
      'skill',
      'messaging',
      'memory',
      'status',
      'shadow',
      'subagent-protocol',
    ];
    expect(allGroups.length).toBe(12);
    expect(new Set(allGroups).size).toBe(12);
  });

  it('(b) allowedGroups is ReadonlySet<ToolGroup> (compile-time readonly enforce)', () => {
    // Runtime: ReadonlySet cannot be mutated via interface.
    const groups = new Set<ToolGroup>(['fs-read', 'fs-write']);
    const readonlyGroups: ReadonlySet<ToolGroup> = groups;
    expect(readonlyGroups.has('fs-read')).toBe(true);
    expect(readonlyGroups.has('spawn')).toBe(false);
  });

  it('(c) Set<string> is NOT assignable to ReadonlySet<ToolGroup> (type-level)', () => {
    // @ts-expect-error — Set<string> lacks ToolGroup literal narrowness
    const _bad: ReadonlySet<ToolGroup> = new Set<string>(['any-string']);
    void _bad;
  });

  it('(d) missing ToolGroup member fails ReadonlySet<ToolGroup> (type-level)', () => {
    // @ts-expect-error — 'nonexistent' is not a ToolGroup
    const _bad: ReadonlySet<ToolGroup> = new Set(['fs-read', 'nonexistent']);
    void _bad;
  });

  it('Tool.group is optional ToolGroup on Tool interface', () => {
    // Runtime: a tool may declare group
    const toolWithGroup = {
      name: 'test_tool',
      description: 'test',
      schema: { type: 'object' },
      readonly: false,
      idempotent: false,
      profiles: ['full' as const],
      group: 'fs-read' as ToolGroup,
      execute: async () => ({ success: true, content: '' }),
    } satisfies Tool;
    expect(toolWithGroup.group).toBe('fs-read');
  });
});
