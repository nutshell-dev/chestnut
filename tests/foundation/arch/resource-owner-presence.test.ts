import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 504: invariant test that resource owner modules physically exist.
 *
 * Lint rules and ratchet tests reference these paths. If anyone renames
 * or removes them without updating dependent rules, this catches it.
 *
 * phase 564 扩 (phase 520-554 follow-up): 加 5 entry 覆盖 motion-claw-id / agent-dir-resolver /
 * claw-status-hints / claw-failure-classes / cli-commands。新 owner module 引入后未加 invariant、
 * 误删不 fail-loud。
 */
describe('resource owner modules physical presence (phase 504 / phase 564 expanded)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  const owners = [
    { name: 'foundation/fs (L1 owner)', rel: 'foundation/fs/node-fs.ts' },
    { name: 'foundation/uuid (entropy owner)', rel: 'foundation/uuid.ts' },
    { name: 'foundation/hash (hash owner)', rel: 'foundation/hash.ts' },
    { name: 'foundation/process-exec (child_process owner)', rel: 'foundation/process-exec/exec.ts' },
    { name: 'foundation/transport (net owner)', rel: 'foundation/transport/unix-socket.ts' },
    // phase 564: phase 520-554 引入的 5 个 owner module
    { name: 'core/claw-topology/motion-claw-id (phase 520: MOTION_CLAW_ID owner)', rel: 'core/claw-topology/motion-claw-id.ts' },
    { name: 'core/claw-topology/agent-dir-resolver (phase 535: motion-vs-claw dir resolver)', rel: 'core/claw-topology/agent-dir-resolver.ts' },
    { name: 'cli/utils/claw-status-hints (phase 540/708)', rel: 'cli/utils/claw-status-hints.ts' },
    { name: 'watchdog/claw-failure-classes (phase 552/708)', rel: 'watchdog/claw-failure-classes.ts' },
    { name: 'cli/utils/cli-commands (phase 554/708)', rel: 'cli/utils/cli-commands.ts' },
  ];

  it.each(owners)('$name file exists at expected path: $rel', ({ rel }) => {
    const full = path.join(srcRoot, rel);
    expect(fs.existsSync(full)).toBe(true);
  });
});
