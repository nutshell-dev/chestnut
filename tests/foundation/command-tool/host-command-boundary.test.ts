import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const COMMAND_TOOL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/foundation/command-tool',
);

describe('CommandTool host command boundary (phase 2062)', () => {
  it('both production entries consume the L1 resolver and pass its result to raw exec', () => {
    const execSource = fs.readFileSync(path.join(COMMAND_TOOL_DIR, 'exec.ts'), 'utf8');

    expect(execSource.match(/resolveHostCommand\(command\)/g)).toHaveLength(2);
    expect(execSource).toContain('exec(hostCommand.executable, hostCommand.args, {');
    expect(execSource).toContain('execWithHandle(hostCommand.executable, hostCommand.args, {');
    expect(execSource).toContain("from '../process-exec/index.js'");
  });

  it('contains no platform selection or local host resolver', () => {
    const execSource = fs.readFileSync(path.join(COMMAND_TOOL_DIR, 'exec.ts'), 'utf8');

    expect(execSource).not.toContain('process.platform');
    expect(execSource).not.toContain('isWindows');
    expect(execSource).not.toContain("platform === 'win32'");
    expect(execSource).not.toContain('host-shell');
    expect(execSource).not.toContain('resolveHostShell');
    expect(execSource).not.toMatch(/hostCommand\.(?:executable|invocation)\s*===/);
    expect(fs.existsSync(path.join(COMMAND_TOOL_DIR, 'host-shell.ts'))).toBe(false);
  });

  it('does not leak host resolution through the CommandTool barrel', () => {
    const barrelSource = fs.readFileSync(path.join(COMMAND_TOOL_DIR, 'index.ts'), 'utf8');

    expect(barrelSource).not.toContain('host-shell');
    expect(barrelSource).not.toContain('host-command');
    expect(barrelSource).not.toContain('resolveHostCommand');
    expect(barrelSource).not.toContain('ResolvedHostCommand');
  });
});
