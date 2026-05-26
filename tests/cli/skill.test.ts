/**
 * Skill command tests
 */
import { describe, it, expect } from 'vitest';
import { skillInstallClawCommand } from '../../src/cli/commands/skill.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('Phase 537 — skillInstallClawCommand traversal guard', () => {
  it('rejects traversal claw id', async () => {
    await expect(skillInstallClawCommand({ fsFactory }, '../foo', 'safe')).rejects.toThrow(/Invalid claw id/);
  });
  it('rejects traversal skill name', async () => {
    await expect(skillInstallClawCommand({ fsFactory }, 'claw1', '../foo')).rejects.toThrow(/Invalid skill name/);
  });
  it('rejects empty params', async () => {
    await expect(skillInstallClawCommand({ fsFactory }, '', 'x')).rejects.toThrow(/Invalid claw id/);
    await expect(skillInstallClawCommand({ fsFactory }, 'claw1', '')).rejects.toThrow(/Invalid skill name/);
  });
});
