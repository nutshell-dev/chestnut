/**
 * skill tool - scope parameter tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createSkillTool } from '../../src/foundation/skill-system/tools/skill.js';
import type { SkillVersions } from '../../src/foundation/skill-system/index.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

async function createTempDir(): Promise<string> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      // phase 1474 Step B: SkillSystem audit required → fixture 供 mock auditWriter
      auditWriter: { write: () => {} } as unknown as AuditLog,
    });
  }

  /** Phase 1919 Step B：dispatch 读取唯一入口 = SkillVersions 固定版本服务 */
  function makeSkillVersions(contents: Record<string, string>): SkillVersions {
    return {
      loadPublished: async (name: string) => {
        const c = contents[name];
        if (c === undefined) throw new Error(`dispatch skill "${name}" has no published version`);
        return c;
      },
    } as unknown as SkillVersions;
  }

  it('should load skill from dispatch pool when scope="dispatch" and Motion identity', async () => {
    const skillVersions = makeSkillVersions({ 'my-skill': `# My Skill\nFull content.` });

    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any, { skillVersions });
    const result = await skillTool.execute(
      { name: 'my-skill', scope: 'dispatch' },
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Full content.');
  });

  it('should return error (not throw) when skill not found in dispatch pool', async () => {
    const skillVersions = makeSkillVersions({});

    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any, { skillVersions });
    const result = await skillTool.execute(
      { name: 'non-existent', scope: 'dispatch' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('non-existent');
  });

  it('should reject scope="dispatch" when identity has no dispatch pool (non-Motion claw)', async () => {
    const ctx = makeCtx();
    const skillTool = createSkillTool({} as any);  // no skillVersions
    const result = await skillTool.execute(
      { name: 'my-skill', scope: 'dispatch' },
      ctx
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('dispatch_scope_unavailable');
    expect(result.content).toContain('Motion only');
  });
});
