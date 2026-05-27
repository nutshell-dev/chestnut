/**
 * Assembly cleanup tests
 *
 * Tests: cleanupOrphanedTemp — 启动期临时残片清理
 * 历史：phase397 自 tests/foundation/fs.test.ts 物理迁。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { cleanupOrphanedTemp } from '../../src/assembly/cleanup.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

describe('cleanupOrphanedTemp', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should clean up orphaned temp files', async () => {
    // Create an orphaned temp file (simulating crash)
    const tempFile = path.join(tempDir, '.tmp_orphaned_123');
    await fs.writeFile(tempFile, 'orphaned content', 'utf-8');

    // Also create a regular file
    const regularFile = path.join(tempDir, 'regular.txt');
    await fs.writeFile(regularFile, 'regular content', 'utf-8');

    // Clean up temp files
    const nodeFs = new NodeFileSystem({ baseDir: tempDir });
    const cleaned = await cleanupOrphanedTemp(nodeFs, tempDir);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toBe(tempFile);

    // Regular file should still exist
    expect(await fs.readFile(regularFile, 'utf-8')).toBe('regular content');
  });

  it('should not leave partial files on crash (simulated)', async () => {
    const filePath = path.join(tempDir, 'atomic-test.txt');
    const originalContent = 'original';

    // Write original content
    await fs.writeFile(filePath, originalContent, 'utf-8');

    // Simulate crash during write by creating temp file but not renaming
    const tempFile = path.join(tempDir, '.tmp_crash_test');
    await fs.writeFile(tempFile, 'new content', 'utf-8');

    // Clean up temp files (simulating recovery on restart)
    const nodeFs2 = new NodeFileSystem({ baseDir: tempDir });
    await cleanupOrphanedTemp(nodeFs2, tempDir);

    // Original file should still have original content
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe(originalContent);
  });
});
