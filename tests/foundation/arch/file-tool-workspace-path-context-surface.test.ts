import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const resolvePathSource = readFileSync(
  new URL('../../../src/foundation/file-tool/resolve-path.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool WorkspacePathContext deep surface', () => {
  it('keeps the path context type local behind resolveWorkspacePath', () => {
    expect(resolvePathSource).not.toMatch(/export\s+type\s+WorkspacePathContext\b/);
    expect(resolvePathSource).toMatch(
      /(?:^|\n)type\s+WorkspacePathContext\s*=\s*Pick<ExecContext,\s*'clawDir'\s*\|\s*'workspaceDir'>;/,
    );
    expect(resolvePathSource).toMatch(/(?:^|\n)\s*ctx:\s*WorkspacePathContext,/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bresolveWorkspacePath\b[^}]*\}\s*from\s*'\.\/resolve-path\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bWorkspacePathContext\b/);
  });
});
