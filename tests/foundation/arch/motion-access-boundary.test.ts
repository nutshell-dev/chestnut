import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTRACT_COMMAND_CATALOG,
  MISC_COMMAND_CATALOG,
  MOTION_COMMAND_CATALOG,
  SUBAGENT_COMMAND_CATALOG,
} from '../../../src/cli-protocol/index.js';
import { MOTION_CLI_COMMAND_REGISTRY } from '../../../src/cli/motion-cli-command-registry.js';

const root = process.cwd();
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const INTERNAL_SYSTEM_ACCESS_OWNERS = new Set([
  'src/assembly/motion-addons.ts',
  'src/assembly/runtime-assembly.ts',
  'src/core/claw-topology/motion-access.ts',
  'src/core/status-service/forum-aggregators.ts',
  'src/daemon/daemon.ts',
  'src/viewport/chat-viewport.ts',
  'src/watchdog/watchdog.ts',
]);

const MOTION_SUBROOT_OWNERS = new Set([
  'src/assembly/contract-action.ts',
  'src/cli/commands/audit-info.ts',
  'src/cli/commands/audit-lookup.ts',
  'src/cli/commands/audit-query.ts',
  'src/cli/commands/launcher-runtime.ts',
  'src/cli/commands/launcher-start.ts',
  'src/cli/commands/motion-daemon.ts',
  'src/cli/commands/motion.ts',
  'src/cli/commands/skill-edit.ts',
  'src/cli/commands/skill-list.ts',
  'src/cli/commands/skill.ts',
  'src/cli/commands/start.ts',
  'src/cli/commands/status.ts',
  'src/cli/commands/stop.ts',
  'src/cli/commands/subagent-helpers.ts',
  'src/cli/start-bootstrap.ts',
  'src/core/claw-topology/location.ts',
  'src/daemon/daemon-handlers.ts',
  'src/daemon/daemon.ts',
  'src/watchdog/watchdog-context.ts',
  'src/watchdog/watchdog.ts',
]);

describe('Motion access architecture boundary', () => {
  it('motion command catalog and guard registry are one-to-one', () => {
    expect(Object.keys(MOTION_CLI_COMMAND_REGISTRY.motion).sort())
      .toEqual(MOTION_COMMAND_CATALOG.map((spec) => spec.id).sort());
  });

  it('every catalog command with --claw is registered in the guard', () => {
    const registered = new Set(MOTION_CLI_COMMAND_REGISTRY.clawOption.map((entry) => entry.path));
    const targetIds = [
      ...CONTRACT_COMMAND_CATALOG.map((spec) => ({ ...spec, id: `contract/${spec.id}` })),
      ...MISC_COMMAND_CATALOG,
      ...SUBAGENT_COMMAND_CATALOG,
    ].filter((spec) => spec.options?.some((option) => option.flag.includes('--claw')))
      .map((spec) => spec.id);
    expect(targetIds.length).toBeGreaterThan(0);
    expect(targetIds.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('only registered internal owners can construct system capabilities', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, 'src'))) {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      if (!/\bcreateInternalSystemMotionAccess\s*\(/.test(source)) continue;
      const relative = path.relative(root, file);
      if (!INTERNAL_SYSTEM_ACCESS_OWNERS.has(relative)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('direct Motion subroot access is limited to registered owners', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, 'src'))) {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      if (!/\bgetNamedSubrootDir\s*\(\s*(?:MOTION_CLAW_ID|'motion'|"motion")\s*\)/.test(source)) continue;
      const relative = path.relative(root, file);
      if (!MOTION_SUBROOT_OWNERS.has(relative)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('Motion location resolver checks capability before resolving its root', () => {
    const source = stripComments(fs.readFileSync(
      path.join(root, 'src/core/claw-topology/location.ts'),
      'utf8',
    ));
    const requireAt = source.indexOf('requireMotionAccess(motionAccess, operation');
    const resolveAt = source.indexOf('getNamedSubrootDir(MOTION_CLAW_ID)');
    expect(requireAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(requireAt);
  });

  it('CLI guard reads env only in the capture function', () => {
    const source = stripComments(fs.readFileSync(
      path.join(root, 'src/cli/motion-cli-guard.ts'),
      'utf8',
    ));
    expect(source.match(/process\.env\[CALLER_AGENT_ID_ENV\]/g)).toHaveLength(2);
    expect(source).toContain('delete process.env[CALLER_AGENT_ID_ENV];');
    expect(source).not.toContain('capturedCallerAgentId ?? process.env');
  });
});
