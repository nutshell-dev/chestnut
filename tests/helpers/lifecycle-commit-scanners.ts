/**
 * Phase 1198 Step E: source scanners backing the terminal lifecycle caller ratchet.
 *
 * Extracted from tests/foundation/arch/contract-lifecycle-caller-ratchet.test.ts
 * to keep the arch test file under the 150-line ratchet. Test-only; not part of
 * the production API.
 */
import { execSync } from 'node:child_process';

/**
 * The generic rename commit must be progress-blind. Patterns intentionally
 * cover direct and callback-mediated mutation spellings.
 */
const PROGRESS_MUTATION_PATTERNS: RegExp[] = [
  /\bsaveProgress\s*\(/,
  /\bwriteAtomic\w*\s*\([^)]*progress/i,
  /\bwrite(?:Exclusive|Sync)?\s*\([^)]*progress/i,
  /\b(?:delete|remove|rm)\w*\s*\([^)]*progress/i,
  /progress\.json/i,
];

function extractCommitBody(src: string): string {
  const marker = 'export async function commitTerminalLifecycle';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('commitTerminalLifecycle definition not found');
  const rest = src.slice(start);
  const next = rest.indexOf('\n/**');
  return next < 0 ? rest : rest.slice(0, next);
}

export function findProgressMutationsInCommit(src: string): string[] {
  const body = extractCommitBody(src);
  return PROGRESS_MUTATION_PATTERNS.filter(p => p.test(body)).map(p => p.source);
}

/** A typed outcome is consumed by assignment, return, or passing as an argument. */
const VOID_SINK_LINE = /^(?:await\s+)?commitTerminalLifecycle\s*\(/;

export function scanSinkLines(grepLines: string[]): string[] {
  return grepLines.filter(line => {
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    const code = line.slice(secondColon + 1).trim();
    return VOID_SINK_LINE.test(code);
  });
}

export function findVoidOutcomeSinks(srcRoot: string): string[] {
  const cmd = `grep -rnE "commitTerminalLifecycle\\(" ${srcRoot} --include='*.ts' || true`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  const lines = out.split('\n').filter(Boolean);
  return scanSinkLines(lines);
}
