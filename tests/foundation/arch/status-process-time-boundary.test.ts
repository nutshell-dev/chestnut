import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(process.cwd(), 'src');
const STATUS_SERVICE = path.join(SRC, 'core', 'status-service');
const STATUS_COMMAND = path.join(SRC, 'cli', 'commands', 'status.ts');

const FORBIDDEN = [
  ['child_process', /(?:node:child_process|from\s+['"]child_process['"])/],
  ['raw process observation import', /from\s+['"][^'"]*process-observation(?:\.js)?['"]/],
  ['process target import', /from\s+['"][^'"]*process-target(?:\.js)?['"]/],
  ['deep start-time import', /from\s+['"][^'"]*process-starttime(?:\.js)?['"]/],
  ['legacy start-time call', /\bgetProcessStartTime\s*\(/],
  ['legacy target observation call', /\bobserveProcessTarget\s*\(/],
  ['legacy string dependency', /\bgetStartTime\s*:/],
  ['raw start-time Date.parse', /\bDate\.parse\s*\(\s*(?:rawStart(?:Time)?|startTime)\s*\)/],
  ['raw start-time Date construction', /\bnew\s+Date\s*\(\s*[^)]*startTime/i],
] as const;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function forbiddenIn(source: string): string[] {
  const normalized = withoutComments(source);
  return FORBIDDEN.flatMap(([label, pattern]) => pattern.test(normalized) ? [label] : []);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
  });
}

describe('StatusService process start-time boundary', () => {
  it('has no legacy string seam, raw OS import or start-time date parsing', () => {
    const offenders = [...sources(STATUS_SERVICE), STATUS_COMMAND].flatMap(file => {
      const labels = forbiddenIn(readFileSync(file, 'utf8'));
      return labels.length > 0 ? [`${path.relative(SRC, file)}: ${labels.join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('uses the narrow barrel capability and typed StatusService mapper', () => {
    const command = readFileSync(STATUS_COMMAND, 'utf8');
    const aggregators = readFileSync(path.join(STATUS_SERVICE, 'forum-aggregators.ts'), 'utf8');
    expect(command).toContain('observeProcessStartTime');
    expect(command).toContain('getProcessStartTimeFact: observeProcessStartTime');
    expect(aggregators).toContain('mapProcessStartTimeToUptime');
    expect(aggregators).toContain('getProcessStartTimeFact: (pid: number) => ProcessStartTimeFact');
  });

  it.each([
    ['child_process', "import { spawnSync } from 'node:child_process';"],
    ['legacy start-time call', 'const start = getProcessStartTime(pid);'],
    ['legacy target observation call', 'const value = observeProcessTarget({ pid });'],
    ['raw start-time Date.parse', 'const startedAtMs = Date.parse(rawStart);'],
    ['raw process observation import', "import { observeProcess } from './process-observation.js';"],
    ['process target import', "import { observeProcessTarget } from './process-target.js';"],
    ['deep start-time import', "import { getProcessStartTime } from './process-starttime.js';"],
    ['legacy string dependency', 'const deps = { getStartTime: (pid: number) => String(pid) };'],
  ])('reverse fixture detects %s', (label, source) => {
    expect(forbiddenIn(source)).toContain(label);
  });

  it('allows the typed barrel capability and strips comments before scanning', () => {
    const allowed = `
      // Date.parse(rawStart) in a comment is not production code.
      import { observeProcessStartTime } from '../../foundation/process-exec/index.js';
      const deps = { getProcessStartTimeFact: observeProcessStartTime };
    `;
    expect(forbiddenIn(allowed)).toEqual([]);
  });

  it('does not ban unrelated audit timestamp parsing', () => {
    expect(forbiddenIn('const activityMs = Date.parse(tsRaw);')).toEqual([]);
  });
});
