/**
 * skill tool - skillsDir parameter tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
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

describe('skill tool skillsDir parameter', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx() {
    return new ExecContextImpl({
      clawId: 'test',
      clawDir: tempDir,
      profile: 'full',
      fs: mockFs,
    });
  }

  it('should load skill from custom skillsDir', async () => {
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
    const skillTool = createSkillTool({} as any);
    const result = await skillTool.execute(
      { name: 'my-skill', skillsDir: 'clawspace/dispatch-skills' },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Full content.');
  });

  it('should return error (not throw) when skill not found in skillsDir', async () => {
    await fs.mkdir(path.join(tempDir, 'clawspace', 'dispatch-skills'), { recursive: true });

    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any);
    const result = await skillTool.execute(
      { name: 'non-existent', skillsDir: 'clawspace/dispatch-skills' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('non-existent');
  });
});
