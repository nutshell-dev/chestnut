import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileTools } from '../../../src/foundation/file-tool/index.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('FileTool zero-input factory surface (phase 1506)', () => {
  it('keeps the six tool names and registration order', () => {
    expect(createFileTools().map(tool => tool.name)).toEqual([
      'read', 'write', 'search', 'ls', 'edit', 'multi_edit',
    ]);
  });

  it('declares createFileTools as a zero-argument factory', () => {
    expect(read('src/foundation/file-tool/create-file-tools.ts')).toContain(
      'export function createFileTools(): Tool[]',
    );
  });

  it('does not expose the retired empty FileToolOptions type', () => {
    expect(read('src/foundation/file-tool/create-file-tools.ts')).not.toContain('FileToolOptions');
    expect(read('src/foundation/file-tool/index.ts')).not.toContain('FileToolOptions');
  });
});
