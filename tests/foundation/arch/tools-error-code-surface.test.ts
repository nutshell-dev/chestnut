import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const errorsSource = readFileSync(
  new URL('../../../src/foundation/tools/errors.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/tools/index.ts', import.meta.url),
  'utf8',
);

describe('Tools ToolErrorCode deep surface', () => {
  it('keeps the tool error code type local behind the error classes', () => {
    expect(errorsSource).not.toMatch(/export\s+type\s+ToolErrorCode\b/);
    expect(errorsSource).toMatch(
      /(?:^|\n)type\s+ToolErrorCode\s*=\s*'TOOL_EXECUTION_FAILED'\s*\|\s*'TOOL_TIMEOUT';/,
    );
    expect(errorsSource).toMatch(
      /export\s+class\s+ToolError\s+extends\s+Error\s*\{\s*\n\s*readonly\s+code:\s*ToolErrorCode\s*=\s*'TOOL_EXECUTION_FAILED';/,
    );
    expect(errorsSource).toMatch(
      /export\s+class\s+ToolTimeoutError\s+extends\s+ToolError\s*\{\s*\n\s*readonly\s+code:\s*ToolErrorCode\s*=\s*'TOOL_TIMEOUT';/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bToolError\b[^}]*\bToolTimeoutError\b[^}]*\}\s*from\s*'\.\/errors\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bToolErrorCode\b/);
  });
});
