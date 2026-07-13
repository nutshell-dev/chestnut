import { describe, it, expect } from 'vitest';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import { lsTool } from '../../../src/foundation/file-tool/ls.js';
import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { searchTool } from '../../../src/foundation/file-tool/search.js';

describe('file-tool Zod strict reject cwd (phase 305 cluster G #9 A 类)', () => {
  const TOOLS = [
    { name: 'read', tool: readTool, validArgs: { path: 'test.ts' } },
    { name: 'write', tool: writeTool, validArgs: { path: 'test.ts', content: 'hello' } },
    { name: 'ls', tool: lsTool, validArgs: { path: '.' } },
    { name: 'edit', tool: editTool, validArgs: { path: 'test.ts', oldText: 'a', newText: 'b' } },
    { name: 'multi_edit', tool: multiEditTool, validArgs: { path: 'test.ts', edits: [] } },
    { name: 'search', tool: searchTool, validArgs: { text: 'hello', path: '.' } },
  ];

  for (const { name, tool, validArgs } of TOOLS) {
    it(`${name}: schema 不含 cwd field (Zod SoT)`, () => {
      const schema = tool.schema as { properties?: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty('cwd');
    });

    it(`${name}: LLM input 含 cwd → execute returns validation failure (Zod strict runtime)`, async () => {
      const mockCtx = {} as any;
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      const result = await tool.execute({ ...validArgs, cwd: '/tmp/illegal' }, mockCtx);
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/validation failed|unrecognized key/i);
    });
  }
});
