/**
 * Motion literal invariant (phase 1265 r135 C fork 2026-05-25)
 *
 * Mechanical grep ban list ratchet: `'motion'` or `"motion"` literal in
 * src/cli/commands/ MUST be `MOTION_CLAW_ID` const (from src/constants.ts).
 *
 * Allowlist exempt:
 * - fs path segment `.clawforum/motion` (skill.ts dir name)
 * - template path segment `templates/motion` (motion.ts template fixture)
 *
 * Mirror templates:
 * - phase 964 silent-x-invariant
 * - phase 1019 audit-events-snapshot-lock
 * - phase 1179 console-business-path-invariant
 * - phase 1244 mock-audit-helper-invariant
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

const SCOPE_DIRS = [
  'src/cli/commands',
  'src/daemon',
  'src/watchdog',
  'src/foundation',
  'src/core',
];

const MOTION_LITERAL_PATTERN = /['"]motion['"]/;

const ALLOWLIST_PATTERNS = [
  // fs path segments (NOT claw id literals)
  /\.clawforum\/motion/,                    // literal '.clawforum/motion' path segment
  /path\.join.*\.clawforum.*['"]motion['"]/, // path.join(..., '.clawforum', 'motion')
  /templates\/motion/,                      // literal 'templates/motion' path segment
  /path\.join.*templates.*['"]motion['"]/,  // path.join(..., 'templates', 'motion')
  // line comments with 'motion' as example label
  /\/\/.*如 'motion'/,
  // phase 1279 r136 E fork NEW patterns
  /getNamedSubrootDir\(['"]motion['"]\)/,    // bucket B fs subdir name passing
  /path\.join.*['"]motion['"]/,             // bucket B other path.join forms
  /['"]motion['"]\s*\|\s*['"]claw['"]/,     // bucket C type literal union (TS discriminated)
  /\*.*['"]motion['"]/,                     // bucket E JSDoc + line comment
  /\/\/.*['"]motion['"]/,                   // bucket E line comment full
];

interface Site {
  file: string;
  line: number;
  excerpt: string;
}

function findMotionLiterals(dir: string): Site[] {
  const sites: Site[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sites.push(...findMotionLiterals(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!MOTION_LITERAL_PATTERN.test(line)) continue;
      if (ALLOWLIST_PATTERNS.some((p) => p.test(line))) continue;
      sites.push({ file: path.relative(PROJECT_ROOT, full), line: i + 1, excerpt: line.trim() });
    }
  }
  return sites;
}

describe('motion literal invariant (phase 1265 r135 C fork + phase 1279 r136 E fork)', () => {
  it('no raw `motion` literal in src/cli/commands/ + src/daemon/ + src/watchdog/ + src/foundation/ + src/core/ (use MOTION_CLAW_ID const)', () => {
    const allSites: Site[] = [];
    for (const scopeDir of SCOPE_DIRS) {
      const dir = path.resolve(PROJECT_ROOT, scopeDir);
      allSites.push(...findMotionLiterals(dir));
    }
    expect(
      allSites,
      `Raw 'motion' literal found. Use MOTION_CLAW_ID from src/constants.ts. Sites: ${JSON.stringify(allSites.slice(0, 10), null, 2)}`,
    ).toEqual([]);
  });

  it('reverse: synthetic raw literal would be caught', () => {
    // verify pattern catches typical raw forms
    expect(MOTION_LITERAL_PATTERN.test(`name === 'motion'`)).toBe(true);
    expect(MOTION_LITERAL_PATTERN.test(`label: "motion",`)).toBe(true);
  });

  it('reverse: allowlist patterns exempt fs path segments', () => {
    expect(ALLOWLIST_PATTERNS.some((p) => p.test(`path.join(root, '.clawforum/motion')`))).toBe(true);
    expect(ALLOWLIST_PATTERNS.some((p) => p.test(`'templates/motion/name'`))).toBe(true);
  });
});
