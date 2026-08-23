import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = path.join(repoRoot, 'tests/foundation/arch/fixtures/spawn-options-surface.ts');

describe('SpawnOptions surface', () => {
  it('compiles through owner and barrel but not manager deep surface', () => {
    const config = ts.readConfigFile(path.join(repoRoot, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
    const program = ts.createProgram({
      rootNames: [fixturePath],
      options: { ...parsed.options, noEmit: true, rootDir: undefined },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }))).toEqual([]);
  });
});
