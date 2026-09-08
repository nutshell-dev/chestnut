/**
 * Phase 1229 Step B: cross-claw read-state persistence ratchet.
 *
 * Cross-claw reads must not create or modify `<targetClawDir>/read-state.json`.
 * The wrapped call uses a transient target ctx with `persistReadFileState: false`
 * and an independent `readFileState` Map; caller and target claw gate states
 * remain untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { readTool } from '../../../src/foundation/file-tool/index.js';
import { createCrossClawReadTool } from '../../../src/core/claw-topology/agent-tools.js';
import { CLAWSPACE_DIR } from '../../../src/foundation/claw-identity/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { READ_STATE_FILE } from '../../../src/foundation/file-tool/file-state-persist.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';

interface TestTopology {
  resolve: (clawId: string) => { kind: 'local'; clawDir: string };
  enumerate: () => string[];
}

describe('cross-claw read-state persistence ratchet (Phase 1229 Step B)', () => {
  let tempDir: string;
  let motionDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    motionDir = path.join(tempDir, 'claws', 'motion');
    targetDir = path.join(tempDir, 'claws', 'target');
    await fs.mkdir(path.join(motionDir, CLAWSPACE_DIR), { recursive: true });
    await fs.mkdir(path.join(targetDir, CLAWSPACE_DIR), { recursive: true });
    await fs.writeFile(path.join(targetDir, CLAWSPACE_DIR, 'note.md'), 'target content');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCallerCtx() {
    const audit = makeAudit();
    const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
    const motionFs = fsFactory(motionDir);
    const ctx = new ExecContextImpl({
      clawsDir: path.join(tempDir, 'claws'),
      clawId: 'motion',
      clawDir: motionDir,
      syncDir: path.join(motionDir, 'tasks', 'sync'),
      profile: 'full',
      fs: motionFs,
      fsFactory,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: motionDir, strict: true, fs: new NodeFileSystem({ baseDir: motionDir }) }),
      auditWriter: audit.audit,
      persistReadFileState: true,
      maxSteps: 20,
    });
    return { ctx, audit };
  }

  it('cross-claw read does not create read-state.json on target claw', async () => {
    const topology: TestTopology = {
      resolve: () => ({ kind: 'local', clawDir: targetDir }),
      enumerate: () => ['target'],
    };
    const tool = createCrossClawReadTool({ topology, allowed: true });
    const { ctx } = makeCallerCtx();

    const result = await tool.execute({ path: 'note.md', claw: 'target' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('target content');

    const targetReadStatePath = path.join(targetDir, READ_STATE_FILE);
    const targetHasReadState = await fs.access(targetReadStatePath)
      .then(() => true)
      .catch(() => false);
    expect(targetHasReadState).toBe(false);
  });

  it('cross-claw read does not pollute caller readFileState', async () => {
    const topology: TestTopology = {
      resolve: () => ({ kind: 'local', clawDir: targetDir }),
      enumerate: () => ['target'],
    };
    const tool = createCrossClawReadTool({ topology, allowed: true });
    const { ctx } = makeCallerCtx();

    expect(ctx.readFileState.size).toBe(0);
    const result = await tool.execute({ path: 'note.md', claw: 'target' }, ctx);
    expect(result.success).toBe(true);

    // Caller Map must remain empty; the transient target Map is discarded.
    expect(ctx.readFileState.size).toBe(0);
  });
});
