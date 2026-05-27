/**
 * Phase 1321 — exec stdin pipe tests (L1)
 *
 * Verifies that content passed via ExecOptions.stdin is piped to child process stdin.
 */

import { describe, it, expect } from 'vitest';
import { exec } from '../../../src/foundation/process-exec/index.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('exec stdin', () => {
  it('should pipe stdin to child process', async () => {
    const result = await exec('sh', ['-c', 'cat'], {
      cwd: os.tmpdir(),
      stdin: 'hello world',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hello world');
  });

  it('should handle empty stdin', async () => {
    const result = await exec('sh', ['-c', 'cat'], {
      cwd: os.tmpdir(),
      stdin: '',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('');
  });

  it('should handle multiline stdin', async () => {
    const content = 'line1\nline2\nline3';
    const result = await exec('sh', ['-c', 'cat'], {
      cwd: os.tmpdir(),
      stdin: content,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(content);
  });

  it('should not interfere when stdin is undefined', async () => {
    const result = await exec('sh', ['-c', 'echo ok'], {
      cwd: os.tmpdir(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ok');
  });

  it('should write content to file via cat redirect', async () => {
    const tmpFile = path.join(os.tmpdir(), `phase1321-test-${Date.now()}.txt`);
    const content = '---\nmarkdown: frontmatter\n---\n\n# Title\n';
    try {
      const result = await exec('sh', ['-c', `cat > "${tmpFile}"`], {
        cwd: os.tmpdir(),
        stdin: content,
      });
      expect(result.exitCode).toBe(0);
      const written = fs.readFileSync(tmpFile, 'utf-8');
      expect(written).toBe(content);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
