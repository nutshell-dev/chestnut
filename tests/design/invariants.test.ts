/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - shadow-signal-omit-anchor.test.ts
 *  - no-magic-sleep-in-tests.test.ts
 *  - no-magic-fallback-default-in-src.test.ts
 *  - no-magic-timing-assertion-in-tests.test.ts
 *  - no-unannotated-silent-catch-in-tests.test.ts
 *  - inbox-write-side-encap-invariant.test.ts
 *  - atomic-write-on-critical-state-invariant.test.ts
 *  - exec-context-narrow-audit-invariant.test.ts
 *  - vi-mock-list-consistency-invariant.test.ts
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { INTEGRATION_PROCESS_FILES, INTEGRATION_IO_FILES, INFRA_FILES } from '../../.config/vitest.config.js';

describe('shadow-signal-omit-anchor', () => {
  /**
   * shadow signal omit anchor comment invariant (phase 1373 sub-4)
   * mechanical lint: verify spawn-shadow-subagent.ts contains the anchor comment.
   */

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(__dirname, '../../src/core/shadow-system/spawn-shadow-subagent.ts');

  describe('shadow signal omit anchor lint (phase 1373 sub-4)', () => {
    it('spawn-shadow-subagent.ts 应包含 phase 1373 anchor comment', () => {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      expect(content).toContain('phase 1373 anchor: shadow-mode subagent 不继承 caller signal by-design');
    });
  });
});

describe('no-magic-sleep-in-tests', () => {
  /**
   * Design invariant: tests must not contain literal-value setTimeout/setInterval calls.
   *
   * Per `memory/playbook/魔法数字.md` Tier 1 零容忍立法.
   *
   * Allowed patterns:
   * - setTimeout/setInterval(fn, NAME_MS) where NAME_MS is a named const with derivation comment
   * - setTimeout/setInterval(fn, opts.intervalMs) where param/var-driven
   * - setImmediate(fn) for yield semantics
   * - String fixtures using template + ${CONST} interpolation
   *
   * Banned patterns:
   * - setTimeout(fn, N) where N is a numeric literal (e.g. 100, 50)
   * - setInterval(fn, N) similarly
   *
   * Phase 318: T-4 子型治理后立此 ratchet 防回归.
   */

  const TESTS_ROOT = path.resolve(__dirname, '..');
  const SELF_RELATIVE = path.join('design', 'no-magic-sleep-in-tests.test.ts');

  const MAGIC_LITERAL_PATTERN = /\b(setTimeout|setInterval)\s*\([^,]+,\s*\d+\s*[,)]/;

  // White-listed files (currently only the invariant test itself).
  // Add new entries with explicit reason comment if needed.
  const ALLOWED_RELATIVE_PATHS = new Set<string>([
    SELF_RELATIVE,
  ]);

  async function* walkTestFiles(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkTestFiles(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        yield full;
      }
    }
  }

  interface Violation {
    file: string;
    line: number;
    text: string;
  }

  describe('design invariant: no magic-value sleep in tests', () => {
    it('no setTimeout/setInterval literal-value call in tests/ (per playbook §零容忍立法)', async () => {
      const violations: Violation[] = [];

      for await (const filePath of walkTestFiles(TESTS_ROOT)) {
        const relative = path.relative(TESTS_ROOT, filePath);
        if (ALLOWED_RELATIVE_PATHS.has(relative)) continue;

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (MAGIC_LITERAL_PATTERN.test(line)) {
            violations.push({
              file: relative,
              line: idx + 1,
              text: line.trim(),
            });
          }
        });
      }

      if (violations.length > 0) {
        const detail = violations
          .map(v => `  ${v.file}:${v.line}  ${v.text}`)
          .join('\n');
        throw new Error(
          `magic-value sleep found (${violations.length} site, 零容忍):\n${detail}\n\n` +
            `Fix: rename literal to inline const NAME_MS with derivation comment.\n` +
            `See memory/playbook/魔法数字.md §T-4 for naming pattern.`,
        );
      }

      expect(violations).toEqual([]);
    });
  });
});

describe('no-magic-fallback-default-in-src', () => {
  /**
   * Design invariant: src 内 `?? N`（N ≥ 2）必须用命名 const，不能是字面 N.
   *
   * Per `memory/playbook/魔法数字.md` §cluster #8 fallback default 子型.
   *
   * White-list（self-describing 或哨兵）：
   * - `?? 0` 累加器 / counter（playbook §不适用「哨兵 0」）
   * - `?? 1` page base / error code 哨兵
   * - `?? 0o644` POSIX file mode（self-describing）
   * - `?? 200/401/403/404/500` HTTP status codes（playbook §不适用）
   *
   * Phase 333: 8 处 src `?? N` 治理后立此 ratchet 防回归.
   */

  const SRC_ROOT = path.resolve(__dirname, '../../src');

  /**
   * Pattern matches: `?? <digit><digit_or_underscore>*` not inside strings.
   * Excludes leading/trailing identifier chars to avoid e.g. `?? 0o644` accidentally matching `?? 0`.
   */
  const MAGIC_FALLBACK_PATTERN = /\?\?\s+([0-9][0-9_]*)/g;

  const ALLOWED_LITERALS = new Set<string>([
    '0',
    '1',
    '200',
    '401',
    '403',
    '404',
    '500',
  ]);

  async function* walkSrcFiles(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkSrcFiles(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        yield full;
      }
    }
  }

  interface Violation {
    file: string;
    line: number;
    literal: string;
    text: string;
  }

  describe('design invariant: no magic fallback default in src', () => {
    it('no `?? N` literal-value fallback in src/ (per playbook §cluster #8)', async () => {
      const violations: Violation[] = [];

      for await (const filePath of walkSrcFiles(SRC_ROOT)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          const re = new RegExp(MAGIC_FALLBACK_PATTERN.source, 'g');
          let m;
          while ((m = re.exec(line)) !== null) {
            const literal = m[1];
            if (ALLOWED_LITERALS.has(literal)) continue;
            violations.push({
              file: path.relative(SRC_ROOT, filePath),
              line: idx + 1,
              literal,
              text: line.trim(),
            });
          }
        });
      }

      if (violations.length > 0) {
        const detail = violations
          .map(v => `  ${v.file}:${v.line}  [?? ${v.literal}]  ${v.text}`)
          .join('\n');
        throw new Error(
          `magic fallback-default literal in src (${violations.length} site, 零容忍):\n${detail}\n\n` +
            `Fix: extract to DEFAULT_* const + jsdoc derivation, then ?? DEFAULT_*.\n` +
            `See memory/playbook/魔法数字.md §cluster #8 for naming pattern.`,
        );
      }

      expect(violations).toEqual([]);
    });
  });
});

describe('no-magic-timing-assertion-in-tests', () => {
  /**
   * Design invariant: tests/ ms-related timing assertion 不能用字面阈值.
   *
   * Per `memory/playbook/魔法数字.md` §T-3/T-4 + phase 333 教训.
   *
   * Matched: `expect(<...elapsed|ms|Ms|duration|backoff|spanMs|minutes|durationMs>)
   *           .toBe(Less|Greater)Than(OrEqual)?(<N>)` 中 N 是 ≥ 10 数字字面
   *
   * White-list：仅 self path（design invariant test 自身的 doc 示例除外、用 N placeholder）
   *
   * Phase 333: ms-related timing assertion 治理后立此 ratchet 防回归.
   */

  const TESTS_ROOT = path.resolve(__dirname, '..');
  const SELF_RELATIVE = path.join('design', 'no-magic-timing-assertion-in-tests.test.ts');

  const MS_RELATED_NAMES = [
    'elapsed',
    'ms',
    'Ms',
    'duration',
    'backoff',
    'spanMs',
    'minutes',
    'durationMs',
    'backoffMs',
    'delayMs',
    'gapMs',
    'timeoutMs',
  ];

  const TIMING_ASSERT_PATTERN = new RegExp(
    `expect\\([^)]*\\b(${MS_RELATED_NAMES.join('|')})\\b[^)]*\\)\\.toBe(Less|Greater)Than(OrEqual)?\\(\\s*([1-9][0-9]+)\\s*\\)`,
  );

  const ALLOWED_RELATIVE_PATHS = new Set<string>([SELF_RELATIVE]);

  async function* walkTestFiles(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkTestFiles(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        yield full;
      }
    }
  }

  interface Violation {
    file: string;
    line: number;
    text: string;
  }

  describe('design invariant: no magic timing-assertion literal in tests', () => {
    it('ms-related timing assertion 不能用字面阈值 (per playbook §test 侧)', async () => {
      const violations: Violation[] = [];

      for await (const filePath of walkTestFiles(TESTS_ROOT)) {
        const relative = path.relative(TESTS_ROOT, filePath);
        if (ALLOWED_RELATIVE_PATHS.has(relative)) continue;

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (TIMING_ASSERT_PATTERN.test(line)) {
            violations.push({
              file: relative,
              line: idx + 1,
              text: line.trim(),
            });
          }
        });
      }

      if (violations.length > 0) {
        const detail = violations
          .map(v => `  ${v.file}:${v.line}  ${v.text}`)
          .join('\n');
        throw new Error(
          `magic timing-assertion literal in tests (${violations.length} site, 零容忍):\n${detail}\n\n` +
            `Fix: rename literal to NAME_MS / NAME_BUDGET_MS / NAME_MARGIN_MS with derivation comment.\n` +
            `See memory/playbook/魔法数字.md §T-3/T-4.`,
        );
      }

      expect(violations).toEqual([]);
    });
  });
});

describe('no-unannotated-silent-catch-in-tests', () => {
  /**
   * Design invariant: tests/ 内 `.catch(() => {})` 必须加 `/* silent: <reason> *​/` annotation.
   *
   * Per `memory/playbook/静默失败.md` §1 + DP-2「错误暴露而非吞没」.
   *
   * src/ 已由 ESLint rule `no-silent-x-without-allowed-pattern` (phase 349) 强制 0 unannotated.
   * tests/ 不在 ESLint scope、本 vitest design test 取而代之锁状态。
   *
   * Allowed patterns:
   * - `.catch(() => { /* silent: <reason> *​/ })` block form
   * - `.catch(() => { // silent: <reason> })` line form
   * - Non-empty catch body (有 audit / console / throw / expect 等已是非 silent)
   *
   * Banned pattern:
   * - `.catch(() => {})` 完全空体且无 silent annotation
   *
   * phase 428: tests/ 230 sites bulk annotate 后立此 ratchet 防回归.
   */

  const TESTS_ROOT = path.resolve(__dirname, '..');
  const SELF_RELATIVE = path.join('design', 'invariants.test.ts');

  // `.catch(() => {})` 完全空体（promise form）— phase 428 立
  const EMPTY_CATCH_PATTERN = /\.catch\(\(\) => \{\}\)/;

  // `} catch {}` / `} catch (e) {}` 完全空块体（block form）— phase 431 立
  const EMPTY_BLOCK_CATCH_PATTERN = /\}\s*catch\s*(?:\(\w*\))?\s*\{\s*\}/;

  // Allowed: 带 silent: 注释（block 或 line form）— 覆盖两种 catch 形式
  const SILENT_ANNOTATION_PATTERN = /(?:\.catch\(\(\) => \{|\}\s*catch\s*(?:\(\w*\))?\s*\{)\s*(?:\/\*\s*silent:|\/\/\s*silent:)/;

  const ALLOWED_RELATIVE_PATHS = new Set<string>([
    SELF_RELATIVE,
    // Allowed: ESLint rule test fixtures (RuleTester embedded code strings、不是真 source)
    path.join('foundation', 'eslint-rules', 'no-silent-catch-outside-allowlist.test.ts'),
    path.join('foundation', 'eslint-rules', 'no-silent-x-without-allowed-pattern.test.ts'),
  ]);

  async function* walkTestFiles(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkTestFiles(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        yield full;
      }
    }
  }

  interface Violation {
    file: string;
    line: number;
    text: string;
  }

  describe('design invariant: no unannotated silent catch in tests', () => {
    it('no `.catch(() => {})` without `silent:` annotation in tests/ (per playbook §静默失败 §1)', async () => {
      const violations: Violation[] = [];
      for await (const file of walkTestFiles(TESTS_ROOT)) {
        const rel = path.relative(TESTS_ROOT, file);
        if (ALLOWED_RELATIVE_PATHS.has(rel)) continue;
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hasEmptyCatch = EMPTY_CATCH_PATTERN.test(line) || EMPTY_BLOCK_CATCH_PATTERN.test(line);
          if (hasEmptyCatch && !SILENT_ANNOTATION_PATTERN.test(line)) {
            violations.push({ file: rel, line: i + 1, text: line.trim() });
          }
        }
      }

      if (violations.length > 0) {
        const detail = violations
          .map(v => `  ${v.file}:${v.line}  ${v.text}`)
          .join('\n');
        throw new Error(
          `unannotated silent catch found (${violations.length} site, 零容忍):\n${detail}\n\n` +
            `Fix: add \`/* silent: <reason> */\` annotation. Common reasons: cleanup, shutdown, expected-failure, best-effort.\n` +
            `See memory/playbook/静默失败.md §1 for pattern guidance.`,
        );
      }
      expect(violations).toEqual([]);
    });
  });
});

describe('inbox-write-side-encap-invariant', () => {
  // phase 1491: cwd 改 process.cwd() / 原硬编码 worktree/phase1334 在 CI + 其他 worktree 上不存在
  const REPO_CWD = process.cwd();

  function safeGrep(cmd: string, cwd: string): string {
    try {
      return execSync(cmd, { encoding: 'utf8', cwd });
    } catch {
      // grep exit 1 = no matches, which is the desired state
      return '';
    }
  }

  describe('inbox write-side encap invariant (phase 1334 r138 E fork)', () => {
    it('cross-module `new InboxWriter` baseline ratchet = 0 outside allowlist', () => {
      // allowlist: src/foundation/messaging/ (codec owner) + src/assembly/ (装配端)
      // + src/cli/ (CLI 入口) + src/foundation/messaging/tools/ (motion LLM tool)
      const out = safeGrep(
        `grep -rn 'new InboxWriter' src/ --include='*.ts' | grep -v test | grep -v 'foundation/messaging' | grep -v 'assembly/' | grep -v 'cli/' | grep -v 'foundation/messaging/tools/'`,
        REPO_CWD,
      );
      const lines = out.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(0);
    });

    // phase 315 Step A: path.join inbox+pending hardcoded ratchet 已迁移为
    // ESLint custom rule `no-hardcoded-inbox-path`。本 grep invariant 删除。
    // phase 705: L4 ClawTopology 提供 routeNotifyClaw 包装器，等价于 notifyClaw 调用站点。

    it('non-deprecated callers use notifyClaw or writeInboxAsync (deep-dream = notifyInbox self-notify exception)', () => {
      const outNotify = execSync(
        `grep -rn 'notifyClaw\\|routeNotifyClaw\\|writeInboxAsync' src/core src/watchdog src/core/memory src/core/contract --include='*.ts' | grep -v test`,
        { encoding: 'utf8', cwd: REPO_CWD },
      );
      expect(outNotify).toContain('heartbeat.ts');
      expect(outNotify).toContain('watchdog-cron.ts');
      expect(outNotify).toContain('watchdog-log.ts');
      expect(outNotify).toContain('random-dream.ts');
      expect(outNotify).toContain('result-delivery.ts');
      expect(outNotify).toContain('verification-notify.ts');

      // deep-dream uses deprecated notifyInbox for self-notify (chrooted fs special case)
      // phase 1493: grep -rn 单文件在 BSD (macOS) vs GNU (Linux) 输出格式差
      //   BSD: `file.ts:N:content`（含 filename prefix）
      //   GNU: `N:content`（单文件不带 filename prefix）
      // 故 assertion 绑 content (notifyInbox) 而非 filename string、跨平台稳定。
      const outInbox = execSync(
        `grep -rn 'notifyInbox' src/core/memory/deep-dream.ts`,
        { encoding: 'utf8', cwd: REPO_CWD },
      );
      expect(outInbox).toMatch(/notifyInbox/);
    });
  });
});

describe('atomic-write-on-critical-state-invariant', () => {
  /**
   * phase 313 invariant: business state write 必经 atomic write
   *
   * 应然：DP1「中断可恢复」+ DP4「磁盘即权威」推 business state write 必经 atomic write
   *   (FileSystem.writeAtomic / writeAtomicSync / writeExclusiveSync)、否则 power loss / OS crash 时半写状态 →
   *   重启 corrupted。
   *
   * 测策略：grep + baseline allow-list（mirror phase 117 + phase 1395 pattern）、扫 src/ 全集
   * raw write call sites（fs.writeFileSync / fs.writeSync / nodeFs.writeFileSync）、白名单 boundary
   * 例外（audit/writer.ts audit-of-audit recursion border、phase 586 ratify）。
   *
   * NEW PR raw write 命中 → fail + 报错引 phase 313 anchor + suggest writeAtomic 替换。
   *
   * Phase 313 SOT（V9 (a) 真治、撤回 phase 306 (C) ratify）、详 `coding plan/phase313/`。
   */

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PROJECT_ROOT = path.resolve(__dirname, '../..');
  const SRC_ROOT = path.join(PROJECT_ROOT, 'src');

  // Raw write patterns that violate the atomic-write SOT.
  const RAW_WRITE_PATTERN = /\b(?:nodeFs|fs)\.(?:writeFileSync|writeSync)\b/g;

  // Atomic write APIs that are the required way to persist critical state.
  const ATOMIC_WRITE_PATTERN = /\b(?:writeAtomic|writeAtomicSync|writeExclusiveSync)\b/g;

  // Boundary exceptions allow-list. Each entry must carry an explicit phase ratify
  // anchor comment explaining why direct nodeFs/fs write is unavoidable.
  const BOUNDARY_ALLOWLIST = new Set([
    // phase 586: audit-of-audit recursion border — audit writer fallback must write
    // directly via nodeFs to avoid recursively triggering the atomic-write audit path
    // when the audit system itself is the caller.
    'src/foundation/audit/writer.ts',
  ]);

  function walk(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...walk(full));
      } else if (stat.isFile() && entry.endsWith('.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  /**
   * Strip TypeScript comments and string literals so that mechanical grep does not
   * flag examples inside documentation or test fixtures.
   *
   * Mirrors the pragmatic lexer-free approach used by tests/design/* invariants.
   */
  function stripCommentsAndStrings(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ')
      .replace(/`(?:\\`|[^`])*`/g, ' ')
      .replace(/'(?:\\'|[^'])*'/g, ' ')
      .replace(/"(?:\\"|[^"])*"/g, ' ');
  }

  describe('phase 313: business state write 必经 atomic write invariant', () => {
    const files = walk(SRC_ROOT);

    it('raw write call sites must be in boundary allowlist or use atomic API', () => {
      const violations: string[] = [];

      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const cleaned = stripCommentsAndStrings(content);
        const matches = cleaned.match(RAW_WRITE_PATTERN);
        if (matches && matches.length > 0) {
          const relPath = path.relative(PROJECT_ROOT, file);
          if (!BOUNDARY_ALLOWLIST.has(relPath)) {
            violations.push(
              `${relPath}: ${matches.length} raw write site(s) — 应用 FileSystem.writeAtomic / writeAtomicSync / writeExclusiveSync；` +
                `若属 boundary 例外、加入 BOUNDARY_ALLOWLIST + 引 phase ratify anchor`,
            );
          }
        }
      }

      if (violations.length > 0) {
        expect.fail(
          `phase 313 invariant 违反 — business state write 必经 atomic write\n` +
            `（DP1「中断可恢复」+ DP4「磁盘即权威」+ ML#9「优先表达让编译器检查」）:\n\n` +
            violations.map((v) => `  - ${v}`).join('\n') +
            `\n\n详 'coding plan/phase313/' + 'design/modules/drift-backlog/l2_audit_log.md' phase 313 row`,
        );
      }
    });

    it('boundary allowlist covers expected exceptions (audit/writer.ts)', () => {
      expect(BOUNDARY_ALLOWLIST.has('src/foundation/audit/writer.ts')).toBe(true);
    });

    it('atomic write API call sites are present (≥40)', () => {
      let totalAtomicSites = 0;

      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const matches = content.match(ATOMIC_WRITE_PATTERN);
        if (matches) {
          totalAtomicSites += matches.length;
        }
      }

      expect(totalAtomicSites).toBeGreaterThanOrEqual(40);
    });
  });
});

describe('exec-context-narrow-audit-invariant', () => {
  /**
   * Phase 1459 α-6 — ExecContext narrow opportunity audit invariant
   *
   * 目的：grep-based 静态 audit / 报告每个 tool 文件消费 `ctx.X` 字段及该字段所属子接口（5 dim 之一）
   * + maintain a baseline snapshot of which tools have narrowed (per α-5 demo) vs which are wide。
   *
   * **本测试不强制 narrow**（α-6 lint hard enforce 留 Meta 候选）；
   * 但提供 visibility：新工具 PR 时 reviewer 可对照基线核「真依赖窄」是否对应 narrow helper / 直接 narrow ctx 类型断言。
   *
   * 字段 → 子接口 mapping（phase 1459 α-1 / 详 `coding plan/phase1455/Step B — design ExecContext ISP.md` §2.1）。
   */

  /** D1 ClawIdentity */
  const D1_FIELDS = new Set([
    'clawId', 'clawDir', 'clawsDir', 'workspaceDir', 'syncDir',
  ]);
  /** D2 ToolPermissions */
  const D2_FIELDS = new Set([
    'profile', 'permissionChecker',
  ]);
  /** D3 ExecutionInfra */
  const D3_FIELDS = new Set([
    'fs', 'fsFactory', 'llm', 'registry', 'taskSystem',
  ]);
  /** D4 ExecutionControl */
  const D4_FIELDS = new Set([
    'signal', 'toolTimeoutMs',
    'stopRequested', 'requestStop', 'getElapsedMs',
  ]);
  /** D5 ExecutionAudit */
  const D5_FIELDS = new Set([
    'auditWriter', 'currentToolUseId', 'trace_id', 'readFileState', 'persistReadFileState', 'getCallerSnapshot', 'subagentTaskId',
  ]);

  /** Phase 807 transitional: callerLabel removed from ExecContext but still referenced in comments. */
  const TRANSITIONAL_FIELDS = new Set(['callerLabel']);

  function classifyField(field: string): string {
    if (D1_FIELDS.has(field)) return 'D1.ClawIdentity';
    if (D2_FIELDS.has(field)) return 'D2.ToolPermissions';
    if (D3_FIELDS.has(field)) return 'D3.ExecutionInfra';
    if (D4_FIELDS.has(field)) return 'D4.ExecutionControl';
    if (D5_FIELDS.has(field)) return 'D5.ExecutionAudit';
    if (TRANSITIONAL_FIELDS.has(field)) return 'Transitional';
    return 'Unknown';
  }

  function listToolFiles(): string[] {
    const out: string[] = [];
    const roots = [
      'src/foundation/file-tool',
      'src/foundation/command-tool',
      'src/foundation/messaging/tools',
      'src/foundation/skill-system/tools',
      'src/core/contract/tools',
      'src/core/spawn-system/tools',
      'src/core/summon-system/tools',
      'src/core/shadow-system/tools',
      'src/core/subagent/tools',
      'src/core/memory/tools',
      'src/core/async-task-system/tools',
      'src/core/claw-topology/tools',
      'src/core/gateway',
      'src/core/status-service',
    ];
    for (const r of roots) {
      if (!fsSync.existsSync(r)) continue;
      const entries = fsSync.readdirSync(r);
      for (const e of entries) {
        if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(path.join(r, e));
      }
    }
    return out;
  }

  function getCtxFields(src: string): string[] {
    const matches = src.match(/ctx\.[a-zA-Z_]+/g) ?? [];
    return Array.from(new Set(matches.map(m => m.substring(4))));
  }

  describe('phase 1459 α-6 ExecContext narrow opportunity audit', () => {
    const files = listToolFiles().filter(f =>
      fsSync.readFileSync(f, 'utf-8').includes('ctx: ExecContext')
    );

    it('(1) every ctx.X field reference must classify into a known dim (no Unknown drift)', () => {
      const unknownFields: { file: string; field: string }[] = [];
      for (const file of files) {
        const src = fsSync.readFileSync(file, 'utf-8');
        const fields = getCtxFields(src);
        for (const f of fields) {
          if (classifyField(f) === 'Unknown') {
            unknownFields.push({ file, field: f });
          }
        }
      }
      expect(unknownFields).toEqual([]);
    });

    it('(2) baseline snapshot: tool → consumed dim set (informational)', () => {
      const report: Record<string, string[]> = {};
      for (const file of files) {
        const src = fsSync.readFileSync(file, 'utf-8');
        const fields = getCtxFields(src);
        const dims = Array.from(new Set(fields.map(classifyField))).sort();
        if (dims.length > 0) report[file] = dims;
      }
      // 基线 assertion：至少存在已 narrow demo 3 个（phase 1459 α-5）+ notify-claw（本 phase 续）
      // 这些 file 真依赖 dim set 应 ≤ 2 个 dim
      const narrowDemos = [
        'src/core/subagent/tools/done.ts',
        'src/core/memory/tools/memory_search.ts',
        'src/foundation/skill-system/tools/skill.ts',
        'src/core/claw-topology/tools/notify-claw.ts',
      ];
      for (const demo of narrowDemos) {
        const dims = report[demo];
        expect(dims, `${demo} should have narrow-able dim set`).toBeDefined();
        expect(dims.length, `${demo} dim count`).toBeLessThanOrEqual(2);
      }
    });

    it('(3) 5 sub-interfaces export covered (regression)', () => {
      const indexSrc = fsSync.readFileSync('src/foundation/tools/index.ts', 'utf-8');
      expect(indexSrc).toContain('ClawIdentity');
      expect(indexSrc).toContain('ToolPermissions');
      expect(indexSrc).toContain('ExecutionInfra');
      expect(indexSrc).toContain('ExecutionControl');
      expect(indexSrc).toContain('ExecutionAudit');
    });
  });
});

describe('vi-mock-list-consistency-invariant', () => {
  /**
   * phase 316 invariant: VI_MOCK_FILES list ↔ tests/ 真 vi.mock use site 一致性
   *
   * 应然：ML#9「不可消除耦合显式表达 / 优先表达让编译器检查」+ 编码规范测试
   *   「让代码经历从未走过的路径」推 vitest.config.ts VI_MOCK_FILES list 必与
   *   tests/ 全集 vi.mock 真 use site 一致 (cross-file static mock race 防漂前置条件)。
   *
   * 测策略：grep + Set diff (mirror phase 313 atomic-write invariant + phase 117/1395 baseline allowlist 模式)。
   *
   * NEW PR 加 vi.mock 但漏 update VI_MOCK_FILES → test fail、报错引 phase 316 + suggest add to list。
   * NEW PR 删 test file 或停 vi.mock 但 list 残留 → test fail、suggest remove from list。
   *
   * Phase 316 SOT (V53 a 真治、撤回 phase 306 (C) ratify「真治推 §10」)、详 `coding plan/phase316/`。
   */

  const REPO_ROOT = path.resolve(__dirname, '../..');

  function walkTests(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkTests(full, out);
      } else if (stat.isFile() && entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  }

  /** Extract VI_MOCK_FILES list entries (only within `const VI_MOCK_FILES = [...]` block). */
  function loadViMockList(): Set<string> {
    const configPath = path.join(REPO_ROOT, '.config/vitest.config.ts');
    const content = readFileSync(configPath, 'utf-8');
    const startIdx = content.indexOf('const VI_MOCK_FILES = [');
    if (startIdx === -1) {
      throw new Error('Could not find `const VI_MOCK_FILES = [` in .config/vitest.config.ts');
    }
    const endIdx = content.indexOf('];', startIdx);
    if (endIdx === -1) {
      throw new Error('Could not find closing `];` for VI_MOCK_FILES list');
    }
    const block = content.slice(startIdx, endIdx);
    const re = /^\s*'(tests\/[^']+)'/gm;
    const list = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      list.add(m[1]);
    }
    return list;
  }

  /** Detect if a test file has a top-level `vi.mock(...)` call (file-level static mock). */
  const VI_MOCK_PATTERN = /^\s*vi\.mock\(/m;

  function loadRealViMockUseSites(): Set<string> {
    const testsRoot = path.join(REPO_ROOT, 'tests');
    const files: string[] = [];
    walkTests(testsRoot, files);

    const real = new Set<string>();
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (VI_MOCK_PATTERN.test(content)) {
        const relPath = path.relative(REPO_ROOT, file);
        real.add(relPath);
      }
    }
    return real;
  }

  /**
   * phase 1006: OS-integration / infra projects run with isolate:true, so their
   * file-level vi.mock do not need to be listed in VI_MOCK_FILES (which guards
   * against cross-file static mock race in isolate:false projects).
   */
  function matchesIntegrationPattern(file: string): boolean {
    const patterns = [
      ...INTEGRATION_PROCESS_FILES,
      ...INTEGRATION_IO_FILES,
      ...INFRA_FILES,
    ];
    return patterns.some(pattern => matchGlob(file, pattern));
  }

  function matchGlob(file: string, pattern: string): boolean {
    const fileParts = file.split('/');
    const patternParts = pattern.split('/');
    return matchParts(fileParts, patternParts);
  }

  function matchParts(fileParts: string[], patternParts: string[]): boolean {
    let f = 0;
    let p = 0;
    while (p < patternParts.length) {
      const pat = patternParts[p];
      if (pat === '**') {
        if (p === patternParts.length - 1) return true;
        const nextPat = patternParts[p + 1];
        while (f < fileParts.length) {
          if (matchSegment(fileParts[f], nextPat)) {
            if (matchParts(fileParts.slice(f + 1), patternParts.slice(p + 2))) {
              return true;
            }
          }
          f++;
        }
        return false;
      }
      if (f >= fileParts.length) return false;
      if (!matchSegment(fileParts[f], pat)) return false;
      f++;
      p++;
    }
    return f === fileParts.length;
  }

  function matchSegment(segment: string, pat: string): boolean {
    const re = new RegExp(
      '^' +
      pat
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLESTAR>>>/g, '.*') +
      '$'
    );
    return re.test(segment);
  }

  describe('phase 316: VI_MOCK_FILES list ↔ tests/ vi.mock use site 一致性 invariant', () => {
    it('VI_MOCK_FILES list entries align with real vi.mock use sites', () => {
      const rawRealUseSites = loadRealViMockUseSites();
      // phase 1006: integration / infra projects run isolate:true and manage their
      // own vi.mock files, so they are exempt from the VI_MOCK_FILES list.
      const realUseSites = new Set(
        Array.from(rawRealUseSites).filter(f => !matchesIntegrationPattern(f)),
      );
      const listEntries = loadViMockList();

      const missingFromList: string[] = [];
      for (const real of realUseSites) {
        if (!listEntries.has(real)) missingFromList.push(real);
      }
      const staleInList: string[] = [];
      for (const listed of listEntries) {
        if (!realUseSites.has(listed)) staleInList.push(listed);
      }

      if (missingFromList.length > 0 || staleInList.length > 0) {
        missingFromList.sort();
        staleInList.sort();
        const parts: string[] = [
          `phase 316 invariant 违反 — VI_MOCK_FILES list ↔ tests/ vi.mock use site 漂`,
          `（ML#9「优先表达让编译器检查」+ 编码规范测试「让代码经历从未走过的路径」）:`,
          '',
        ];
        if (missingFromList.length > 0) {
          parts.push(`Missing from VI_MOCK_FILES (${missingFromList.length} entries to ADD):`);
          for (const f of missingFromList) parts.push(`  + '${f}',`);
          parts.push('');
        }
        if (staleInList.length > 0) {
          parts.push(`Stale in VI_MOCK_FILES (${staleInList.length} entries to REMOVE):`);
          for (const f of staleInList) parts.push(`  - '${f}',`);
          parts.push('');
        }
        parts.push(`Update .config/vitest.config.ts VI_MOCK_FILES list、保 commented-out 历史段不动。`);
        parts.push(`详 'coding plan/phase316/' + 'design/modules/drift-backlog/l2_audit_log.md' phase 316 row。`);
        throw new Error(parts.join('\n'));
      }
    });

    it('VI_MOCK_FILES list has ≥100 entries (sanity guard)', () => {
      const listEntries = loadViMockList();
      expect(listEntries.size).toBeGreaterThanOrEqual(100);
    });

    it('real vi.mock use sites have ≥100 entries (sanity guard)', () => {
      const realUseSites = loadRealViMockUseSites();
      expect(realUseSites.size).toBeGreaterThanOrEqual(100);
    });
  });
});
