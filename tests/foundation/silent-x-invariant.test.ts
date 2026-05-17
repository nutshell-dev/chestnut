import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import baselineJson from './silent-x-baseline.json';

const SRC_DIR = path.resolve(__dirname, '../../src');

interface CatchSite {
  file: string;
  line: number;
  body: string;
}

function findCatchSites(content: string, filePath: string): CatchSite[] {
  const sites: CatchSite[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const catchMatch = line.match(/\bcatch(\s*\([^)]*\))?\s*\{/);
    if (!catchMatch) continue;

    const braceIdx = line.indexOf('{', catchMatch.index! + catchMatch[0].indexOf('{'));
    if (braceIdx === -1) continue;

    let depth = 1;
    const bodyLines: string[] = [];
    let lineRest = line.slice(braceIdx + 1);
    let j = i;

    while (depth > 0 && j < lines.length) {
      if (j > i) lineRest = lines[j];
      for (const ch of lineRest) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth === 0) break;
      }
      bodyLines.push(lineRest);
      j++;
      if (depth === 0) break;
    }

    sites.push({ file: filePath, line: i + 1, body: bodyLines.join('\n') });
  }

  return sites;
}

const ALLOWED_PATTERNS = [
  // Canonical silent annotation
  /\/\/\s*silent:/,
  /\/\*\s*silent:/,
  // Audit
  /\baudit/,
  /\bauditWriter\??\.write\(/,
  // Throw
  /\bthrow\b/,
  // Console
  /\bconsole\.(error|warn|log|info|debug)\(/,
  // Process exit
  /\bprocess\.exitCode\s*=/,
  /\bprocess\.exit\(/,
  // Error handling helpers
  /\bhandleCliError\b/,
  /\bfireTransportError\b/,
  /\bonStreamParseError\b/,
  /\bdropConnection\b/,
  /\bbackupCorrupt\b/,
  /\bremoveWatchdogPid\b/,
  // Logging / output
  /\blog\(/,
  /\bappendOutput\b/,
  /\blines\.push\(/,
  // Structured error returns
  /\breturn\s*\{\s*(success|ok|passed|alive|winner|error|content|reason|lastEventMs|lastError|pid|command)/,
  // Simple returns with values
  /\breturn\s+(false|true|0|null|undefined|await|base|this\.)/,
  /\breturn\s*;/,
  /\breturn\s*\[\]/,
  /\breturn\s+pids\.map/,
  /\breturn\s+errResult\(/,
  // Control flow
  /\bcontinue\s*;/,
  // Conditional handling
  /\bif\s*\(\s*(err|error)/,
  /\bif\s*\(\s*\(/, // catch-all for if ( expressions
  // Assignments that indicate handling
  /\b(errorText|moveOk|saveFailed|moveErr|skillsSource|srcPath|result|lines|contractAudit|motionAudit|shimAudit|systemAudit|auditError|handlerPromise|track\.isAlive)\s*=/,
  /\bconst\s+\w+\s*=\s*(err|error)/,
  // Generic function calls that indicate non-silent
  /\bPromise\.reject\(/,
  /\bonSkip\(/,
  /\bturnTracker\.forceReset\(/,
  /\bformatErr\(/,
  // Generic write/error calls from audit-like objects
  /\b\w*[Aa]udit\w*\.write\(/,
  /\b\w*[Ee]rror\w*\(/,
];

function isAllowed(body: string): boolean {
  return ALLOWED_PATTERNS.some(p => p.test(body));
}

function* walkSrc(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* walkSrc(path.join(dir, entry.name));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield path.join(dir, entry.name);
  }
}

describe('phase 964: silent X invariant (lint enforcement)', () => {
  it('every catch block in src/ contains audit/throw/console/silent:-annotation OR is in baseline whitelist', () => {
    const baselineKeys = new Set(baselineJson.entries.map(e => `${e.file}:${e.line}`));
    const violations: string[] = [];

    for (const filePath of walkSrc(SRC_DIR)) {
      const relPath = path.relative(path.resolve(__dirname, '../../'), filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const sites = findCatchSites(content, relPath);
      for (const site of sites) {
        if (isAllowed(site.body)) continue;
        const key = `${site.file}:${site.line}`;
        if (baselineKeys.has(key)) continue;
        violations.push(`${key}\n  body: ${site.body.slice(0, 120).replace(/\n/g, ' ')}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `silent X invariant violation (${violations.length}):\n` +
        violations.join('\n') +
        `\n\nFix options:\n` +
        `  (a) add audit.write(...) / throw / console.error(...) to catch body\n` +
        `  (b) add canonical comment \`// silent: <reason>\` OR \`/* silent: <reason> */\`\n` +
        `  (c) (only for pre-existing) add entry to tests/foundation/silent-x-baseline.json`
      );
    }
  });

  it('baseline whitelist entries 不重复', () => {
    const keys = baselineJson.entries.map(e => `${e.file}:${e.line}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('baseline whitelist entries 每个 reason 字段非空', () => {
    for (const e of baselineJson.entries) {
      expect(e.reason).toBeTruthy();
      expect(e.reason.length).toBeGreaterThan(5);
    }
  });

  it('reverse: NEW silent catch w/o annotation / w/o whitelist → invariant fails', () => {
    const synthetic = 'function x() { try { foo(); } catch { } }';
    const sites = findCatchSites(synthetic, 'synthetic.ts');
    expect(sites.length).toBe(1);
    expect(isAllowed(sites[0].body)).toBe(false);
  });

  it('reverse: catch with console.error is allowed', () => {
    const synthetic = 'function x() { try { foo(); } catch { console.error(e); } }';
    const sites = findCatchSites(synthetic, 'synthetic.ts');
    expect(sites.length).toBe(1);
    expect(isAllowed(sites[0].body)).toBe(true);
  });

  it('reverse: catch with throw is allowed', () => {
    const synthetic = 'function x() { try { foo(); } catch { throw e; } }';
    const sites = findCatchSites(synthetic, 'synthetic.ts');
    expect(sites.length).toBe(1);
    expect(isAllowed(sites[0].body)).toBe(true);
  });

  it('reverse: catch with canonical silent comment is allowed', () => {
    const synthetic = 'function x() { try { foo(); } catch { // silent: expected failure } }';
    const sites = findCatchSites(synthetic, 'synthetic.ts');
    expect(sites.length).toBe(1);
    expect(isAllowed(sites[0].body)).toBe(true);
  });
});
