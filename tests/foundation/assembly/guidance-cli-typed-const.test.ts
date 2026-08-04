/**
 * phase 1469 invariant: composer 文件内 `chestnut X Y` 模式字面必经
 * typed const / helper 引用、不可裸字符串拼接.
 *
 * phase 1476 reframe: `CLI_COMMANDS` (verb-first 字面) → typed helper (subject-first 形态)
 * + `CONTRACT_COMMANDS.X` typed const（contract 子命令保 verb-first）.
 * phase 1253: helper/const owner 迁 CLIProtocol — `renderClawInvocation(id, '<command>')`
 * + `CONTRACT_COMMANDS.X`（from src/cli-protocol/index.js）.
 * phase 1270 Step A: 旧 helper/const 从 public barrel 退役为 CLIProtocol 模块内部实现
 * （仅供同模块 guidance.ts import）；CLIProtocol 外 deep-import invocation.js 由本文件
 * scanner 反向锁定。composer 不再建议旧 API — CLI affordance 一律 typed binding →
 * CliGuidanceDocument → CLIProtocol 注册/渲染。
 *
 * phase 193 Step A: regex 改抓嵌入式字面（不要求整个 string literal 是 chestnut X Y）
 * + 加 stripComments 排除注释行误报.
 *
 * phase 195 Step A: scope 扩 src/core + src/foundation（排除 cli/assembly/prompts/watchdog）
 * + 加 STEP_B_PENDING_ALLOW（exec.ts:135 + forum-formatter.ts:22 待 Step B design 审）.
 *
 * 守 M#9「不可消除的耦合应显式表达、优先表达为让编译器检查」 — typed const enable
 * 编译期 typo 检测、配 invariant runtime 兜底 surface bypass detection.
 *
 * scope：composers/<type>.ts 内任何 string literal 含 `chestnut` 前缀 + 多 token 模式 →
 * 违反；唯一豁免 = composers/index.ts（barrel）+ types.ts（NO_GUIDANCE sentinel 不含字面）。
 *
 * phase 1263 Step C: bindings/<type>.ts（Assembly typed binding）同规则 —
 * binding 只做 owner state → CliGuidanceDocument 穷尽映射，CLI literal 与最终渲染
 * 唯一归 CLIProtocol；binding 内出现裸 chestnut 字面 = 违反。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectSrc = path.resolve(__dirname, '../../../src');
const composersDir = path.resolve(__dirname, '../../../src/assembly/guidance/composers');
const bindingsDir = path.resolve(__dirname, '../../../src/assembly/guidance/bindings');

/** 简化注释剥离：块注释保换行、行注释删除（避免误抓 url 内 //） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

/** 递归遍历 .ts 文件 */
function walkTsFiles(dir: string, cb: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, cb);
    else if (entry.isFile() && entry.name.endsWith('.ts')) cb(full);
  }
}

// phase 195 Step B 待审 ratify 中、暂 allow（Step B 后由 follow-up phase 治 / 删此 allow）
//
// phase 339 Step F: 改用 (file, "chestnut <verb>") 锚 — 不再用 line number.
// 旧锚 line: forum-formatter.ts:22 → :32（D）→ :32（F 不变）; exec.ts:135 → :147（F）
// 历次 jsdoc / 上方 code 增长每次都要 sync line number、维护负担高。
// 新锚（file, chestnut + first verb）对 line 移动不敏感、对 string 内 trailing 内容不敏感.
const STEP_B_PENDING_ALLOW = new Set([
  'foundation/command-tool/exec.ts::chestnut stop',
  'core/status-service/forum-formatter.ts::chestnut status',
  // phase 540 / phase 708 / phase 1278 Step A: claw status hint formatter 归位 CLIProtocol
  // （src/cli-protocol/claw-status-hint.ts）、用于 motion-addons + cli/claw-send
  // 'chestnut claw' 字面是 CLI 启动命令、属业务文案；M#5 严格扫由本 allowlist 承认 pure formatter
  // 持 CLI literal 的 by-design 例外（与下方 invocation.ts 同型：唯一实现处本就该有 CLI literal）
  'cli-protocol/claw-status-hint.ts::chestnut claw',
  // phase 554 / phase 708 / phase 1253 / phase 1270: invocation.ts 是 CLIProtocol 内部唯一
  // CLI 字面 owner（claw invocation + contract 命令族），仅供同模块 guidance.ts 使用、
  // 不经 public barrel 公开；持字面 by-design — 唯一实现处本就该有 CLI literal、否则失语义
  'cli-protocol/invocation.ts::chestnut claw',
  'cli-protocol/invocation.ts::chestnut contract',
]);

const SCAN_DIRS = ['core', 'foundation'];
const EXCLUDE_PATTERNS = [/^\/cli\//, /^\/assembly\//, /^\/prompts\//, /^\/watchdog\//, /\.test\./];

/**
 * import/export ... from 语句的 module specifier（含 mixed 与 type-only 形态）。
 * global flag：只供 matchAll 使用，禁止以 .test() 复用（lastIndex 漂移）。
 */
const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:type\s+)?(?:[\w*{][^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/** CLIProtocol 内部 invocation 文件 specifier 判定：任何相对/深链路径形态命中。 */
function isInvocationSpecifier(specifier: string): boolean {
  return /(?:^|\/)cli-protocol\/invocation\.js$/.test(specifier);
}

// 日志 prefix 模式：`[chestnut <namespace>]` 不抓（namespace 标识、非 CLI 命令）
const LOG_PREFIX_RE = /\[chestnut\s+\w+\]/;

/** 扫目录内 .ts 文件的 string literal，收集裸 `chestnut X Y` 字面违规。 */
function collectBareCliLiterals(dir: string, exclude: Set<string>): Array<{ file: string; line: number; literal: string }> {
  const violations: Array<{ file: string; line: number; literal: string }> = [];
  if (!fs.existsSync(dir)) return violations;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !exclude.has(f))) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const lines = stripComments(content).split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      // 扫该行所有 string literal（双引号 / 单引号 / 模板）
      const stringLiteralRe = /(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;
      for (const m of line.matchAll(stringLiteralRe)) {
        const literalContent = m[1] ?? m[2] ?? m[3] ?? '';
        // 在 literal 内容里找 `chestnut` 前缀模式（不要求紧贴首尾）
        const chestnutMatch = literalContent.match(/chestnut\s+\w+(?:\s+\S+)*/);
        if (chestnutMatch) {
          violations.push({ file, line: lineIdx + 1, literal: chestnutMatch[0] });
        }
      }
    }
  }
  return violations;
}

describe('phase 1469: guidance composer 禁裸 CLI 字面（CLI affordance 经 typed binding/document）', () => {
  it('composer files contain no bare `chestnut X Y` string literals (embedded or whole)', () => {
    const violations = collectBareCliLiterals(composersDir, new Set(['index.ts']));

    if (violations.length > 0) {
      const summary = violations
        .map(v => `  - ${v.file}:${v.line}: '${v.literal}'`)
        .join('\n');
      throw new Error(
        `phase 1469 invariant failed — ${violations.length} bare 'chestnut X Y' literal(s) in composer files:\n${summary}\n` +
          `CLI affordance 已迁 typed binding/document：Assembly binding 产 CliGuidanceDocument 并经 CLIProtocol 注册/渲染，不再直接引用 invocation helper/constants。`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('phase 1263 Step C: binding files contain no bare `chestnut X Y` string literals (typed-only adapters)', () => {
    const violations = collectBareCliLiterals(bindingsDir, new Set());

    if (violations.length > 0) {
      const summary = violations
        .map(v => `  - ${v.file}:${v.line}: '${v.literal}'`)
        .join('\n');
      throw new Error(
        `phase 1263 invariant failed — ${violations.length} bare 'chestnut X Y' literal(s) in binding files:\n${summary}\n` +
          `Bindings must only map owner state to CliGuidanceDocument; CLI literals and final rendering belong to CLIProtocol.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('src/core + src/foundation contain no bare chestnut CLI literals (M#5 violation)', () => {
    const violations: Array<{ file: string; line: number; literal: string }> = [];
    for (const subDir of SCAN_DIRS) {
      const dir = path.join(projectSrc, subDir);
      walkTsFiles(dir, file => {
        const rel = path.relative(projectSrc, file);
        if (EXCLUDE_PATTERNS.some(re => re.test('/' + rel))) return;

        const content = stripComments(fs.readFileSync(file, 'utf-8'));
        content.split('\n').forEach((line, idx) => {
          // 扫 string literal 内的 chestnut 字面、排除日志 prefix
          const stringLiteralRe = /(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;
          for (const m of line.matchAll(stringLiteralRe)) {
            const literalContent = m[1] ?? m[2] ?? m[3] ?? '';
            if (LOG_PREFIX_RE.test(literalContent)) continue;  // 排除 [chestnut spawn] 类
            const chestnutMatch = literalContent.match(/chestnut\s+\w+(?:\s+\S+)*/);
            if (chestnutMatch) {
              violations.push({ file: rel, line: idx + 1, literal: chestnutMatch[0] });
            }
          }
        });
      });
    }

    // 过滤 Step B 待审项 — 用 (file, "chestnut <first-verb>") 锚而非 line number
    // 抓 chestnut + 紧跟的 word（不含 trailing 内容）做稳定指纹
    const filtered = violations.filter(v => {
      const firstTwoTokens = v.literal.match(/^chestnut\s+\w+/)?.[0];
      if (!firstTwoTokens) return true;
      return !STEP_B_PENDING_ALLOW.has(`${v.file}::${firstTwoTokens}`);
    });

    if (filtered.length > 0) {
      const summary = filtered.map(v => `  - ${v.file}:${v.line}: '${v.literal}'`).join('\n');
      throw new Error(
        `M#5 violation — ${filtered.length} bare chestnut CLI literal(s) in src/core + src/foundation:\n${summary}\n` +
          `Business modules must not contain CLI literals. Move CLI hint to CLI handler layer.`,
      );
    }
    expect(filtered).toEqual([]);
  });

  it('phase 1270 Step A: CLIProtocol 外源码不得 deep-import cli-protocol/invocation.js', () => {
    const cliProtocolDir = path.join(projectSrc, 'cli-protocol');
    const violations: string[] = [];
    walkTsFiles(projectSrc, file => {
      if (file.startsWith(cliProtocolDir + path.sep)) return; // 模块内协作（guidance.ts → invocation.ts）合法
      const content = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
        if (isInvocationSpecifier(m[1])) {
          violations.push(`${path.relative(projectSrc, file)}: '${m[1]}'`);
        }
      }
    });

    if (violations.length > 0) {
      const summary = violations.map(v => `  - ${v}`).join('\n');
      throw new Error(
        `phase 1270 invariant failed — ${violations.length} deep import(s) of CLIProtocol-internal invocation.js outside src/cli-protocol:\n${summary}\n` +
          `renderClawInvocation/CONTRACT_COMMANDS 已退役为 CLIProtocol 内部实现；CLI affordance 必经 typed guidance binding/document（src/cli-protocol/index.js 的 registerCliGuidance 等 barrel API）。`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('phase 1270 Step A 反向 fixture：deep-import scanner 识别 mixed/type-only/re-export 形态、不误放合法 specifier', () => {
    const bad = [
      "import { renderClawInvocation } from '../cli-protocol/invocation.js';",
      "import type { Foo } from '../../cli-protocol/invocation.js';",
      "import { type Foo, bar } from '../cli-protocol/invocation.js';",
      "export { CONTRACT_COMMANDS } from '../cli-protocol/invocation.js';",
      "export * from './cli-protocol/invocation.js';",
      "import * as inv from '../cli-protocol/invocation.js';",
      "import '../cli-protocol/invocation.js';",
    ];
    for (const s of bad) {
      const m = [...s.matchAll(IMPORT_SPECIFIER_RE)];
      expect(m, s).toHaveLength(1);
      expect(isInvocationSpecifier(m[0][1]), s).toBe(true);
    }
    const good = [
      "import { renderCliGuidanceDocument } from '../cli-protocol/index.js';",
      "import { renderClawInvocation } from './invocation.js';",
      "import type { CliGuidanceDocument } from '../../cli-protocol/guidance.js';",
    ];
    for (const s of good) {
      const m = [...s.matchAll(IMPORT_SPECIFIER_RE)];
      expect(m, s).toHaveLength(1);
      expect(isInvocationSpecifier(m[0][1]), s).toBe(false);
    }
  });
});
