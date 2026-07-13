/**
 * status-tool FS_NOT_FOUND check — reverse test for phase 883 B1
 *
 * Mock ctx.fs.list throwing FileNotFoundError (code='FS_NOT_FOUND') must NOT
 * trigger TASK_PENDING_ERROR / TASK_RUNNING_ERROR audit rows.
 */

import { describe, it, expect, vi } from 'vitest';
import { createStatusTool } from '../../../src/core/status-service/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';

describe('status-tool FS_NOT_FOUND handling (phase 883 B1)', () => {
  it('should NOT audit TASK_PENDING_ERROR when pending dir throws FS_NOT_FOUND', async () => {
    const auditWriter = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const mockFs = {
      list: vi.fn().mockRejectedValue(new FileNotFoundError('/tasks/queues/pending')),
    } as unknown as NodeFileSystem;

    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: '/tmp/test-claw',
      profile: 'full',
      fs: mockFs,
      auditWriter: auditWriter as any,
    });

    const statusTool = createStatusTool({ loadActive: vi.fn().mockResolvedValue(null) } as any);
    const result = await statusTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(auditWriter.write).not.toHaveBeenCalledWith(
      expect.stringContaining('pending'),
      expect.anything(),
    );
  });

  it('should NOT audit TASK_RUNNING_ERROR when running dir throws FS_NOT_FOUND', async () => {
    const auditWriter = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    let callCount = 0;
    const mockFs = {
      list: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // pending succeeds
          return [];
        }
        // running throws FS_NOT_FOUND
        throw new FileNotFoundError('/tasks/queues/running');
      }),
    } as unknown as NodeFileSystem;

    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: '/tmp/test-claw',
      profile: 'full',
      fs: mockFs,
      auditWriter: auditWriter as any,
    });

    const statusTool = createStatusTool({ loadActive: vi.fn().mockResolvedValue(null) } as any);
    const result = await statusTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(auditWriter.write).not.toHaveBeenCalledWith(
      expect.stringContaining('running'),
      expect.anything(),
    );
  });
});
