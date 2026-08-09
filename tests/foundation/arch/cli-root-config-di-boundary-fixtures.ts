/**
 * Phase 1324 Step C: CLI RootConfig DI 边界 ratchet 的纯 scanner/baseline helper。
 *
 * 只承载路径、scanner、精确 baseline 与共享正则；不含任何 test case。
 * scanner 正则与排序逐字迁自原 cli-root-config-di-boundary.test.ts
 * （phase 1301/1323 既有 ratchet 语义），不为"优化"改动而漏扫 dynamic/multiline import。
 * 本文件在 tests 下，不被 production importer scanner 纳入（scanner 只扫 src/cli）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CLI_ROOT = path.resolve(__dirname, '..', '..', '..', 'src', 'cli');
export const INDEX_TS = path.join(CLI_ROOT, 'index.ts');
export const ROUTER_TS = path.join(CLI_ROOT, 'commands', 'claw-router.ts');
export const CLAW_DEPS_TS = path.join(CLI_ROOT, 'commands', 'claw-command-deps.ts');
export const AUDIT_COMMANDS = ['audit-info.ts', 'audit-lookup.ts', 'audit-query.ts'];
export const CLAWSPACE_COMMANDS = ['claw-read.ts', 'claw-ls.ts'];
export const CLAW_INSPECTION_COMMANDS = ['claw-health.ts', 'claw-status.ts'];
export const CLAW_DAEMON_LIFECYCLE_COMMANDS = ['claw-daemon.ts', 'claw-stop.ts'];
export const CLAW_INPUT_COMMANDS = ['claw-send.ts', 'claw-import.ts'];
export const CLAW_OBSERVATION_COMMANDS = ['claw-trace.ts', 'claw-stream.ts'];

/** 静态（含 multiline / type）与 dynamic import specifier 扫描。 */
export function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re = /import(?:\s+type)?[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) specs.push((m[1] ?? m[2]) as string);
  return specs;
}

function listTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listTsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** CLI production 下 import `assembly/config/config-load.js` 的相对路径集合。 */
export function configLoadImporters(): string[] {
  return listTsFiles(CLI_ROOT)
    .filter((f) => importSpecifiers(fs.readFileSync(f, 'utf8')).some((s) => s.endsWith('assembly/config/config-load.js')))
    .map((f) => path.relative(CLI_ROOT, f))
    .sort();
}

// Migration baseline（phase 1328 Step C：trace/stream 迁出，16→14）：精确路径集合，
// 非计数；一删一增抵消会被拒。后续每个命令族治理 phase 必须同步递减本清单。
export const REMAINING_BASELINE = [
  'audit-config-migration.ts', 'commands/claw-chat.ts', 'commands/claw-create.ts',
  'commands/claw-list.ts',
  'commands/claw-watch.ts', 'commands/config.ts', 'commands/init.ts',
  'commands/motion-daemon.ts', 'commands/motion.ts', 'commands/start.ts',
  'commands/status.ts', 'commands/stop.ts', 'llm-connection-check.ts',
  'watchdog-config-migration.ts',
].sort();

export const NARROW_PICK = /rootConfig:\s*Pick<RootConfigReader,\s*'loadGlobal'\s*\|\s*'loadClaw'>/;
