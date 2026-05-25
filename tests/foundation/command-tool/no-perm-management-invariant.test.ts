import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * phase 1280 r136 B fork mechanical invariant lint:
 * - ban allowList\|denyList in src/foundation/command-tool/
 * - ban command_tool_command_rejected audit event in src/
 * REFRAMED-OUT by-design 2026-05-25 user ratify.
 * 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup +
 *    project memory project_command_tool_no_perm.md
 */

const CMD_TOOL_DIR = join(__dirname, '../../../src/foundation/command-tool');
const SRC_DIR = join(__dirname, '../../../src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('phase 1280 no-perm-management invariant', () => {
  it('ban allowList in src/foundation/command-tool/', () => {
    const files = listTsFiles(CMD_TOOL_DIR);
    const hits: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (/\ballowList\b/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('ban denyList in src/foundation/command-tool/', () => {
    const files = listTsFiles(CMD_TOOL_DIR);
    const hits: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (/\bdenyList\b/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('ban command_tool_command_rejected audit event in src/', () => {
    const files = listTsFiles(SRC_DIR);
    const hits: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (/command_tool_command_rejected/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
