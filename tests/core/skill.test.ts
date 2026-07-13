/**
 * skill tool - scope parameter tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createSkillTool } from '../../src/foundation/skill-system/tools/skill.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';

async function createTempDir(): Promise<string> {
  const d = path.join(tmpdir(), `skill-test-${randomUUID()}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe('skill tool scope parameter', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeCtx() {
    return new ExecContextImpl({
      clawId: 'test',
      clawDir: tempDir,
      profile: 'full',
      fs: mockFs,
    });
  }

  it('should load skill from dispatch pool when scope="dispatch" and Motion identity', async () => {
    await fs.mkdir(path.join(tempDir, 'clawspace', 'dispatch-skills', 'my-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'clawspace', 'dispatch-skills', 'my-skill', 'SKILL.md'),
      `---
name: my-skill
description: My dispatch skill
---
# My Skill
Full content.
`
    );

    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any, { dispatchSkillsDir: 'clawspace/dispatch-skills' });
    const result = await skillTool.execute(
      { name: 'my-skill', scope: 'dispatch' },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Full content.');
  });

  it('should return error (not throw) when skill not found in dispatch pool', async () => {
    await fs.mkdir(path.join(tempDir, 'clawspace', 'dispatch-skills'), { recursive: true });

    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any, { dispatchSkillsDir: 'clawspace/dispatch-skills' });
    const result = await skillTool.execute(
      { name: 'non-existent', scope: 'dispatch' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('non-existent');
  });

  it('should reject scope="dispatch" when identity has no dispatch pool (non-Motion claw)', async () => {
    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any);  // no dispatchSkillsDir
    const result = await skillTool.execute(
      { name: 'my-skill', scope: 'dispatch' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('dispatch_scope_unavailable');
    expect(result.content).toContain('Motion only');
  });
});
