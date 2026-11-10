/**
 * @module L2c.FileTool
 * search tool — unified filename + content substring search.
 *
 * phase 1422: design 落地（Q1 pattern + Q2 unified + Q3 skip 分类 + Q4 binary detect
 * + default exclude + Q5 全英 + Q6 全扫 / overflow 落盘 / 预览 20 + Q7 cross-claw prefix）。
 */

import { newShortUuid, truncateUtf8Prefix } from  '../node-utils/index.js';
import * as nodePath from 'path';
import { z } from 'zod';
import { isFileNotFound, type FileSystem } from '../fs/index.js';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { defineFileToolSchema } from './_zod-helper.js';

import { formatErr } from '../node-utils/index.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_SYNC_SEARCH_DIR,
  SEARCH_PREVIEW_LIMIT,
  SEARCH_BINARY_DETECT_BYTES,
  SEARCH_MAX_FILE_SIZE,
  SEARCH_DEFAULT_EXCLUDE,
  SEARCH_SKIP_DISPLAY_LIMIT,
  SEARCH_PREVIEW_LINE_MAX_BYTES,
  SEARCH_OUTPUT_MAX_BYTES,
} from './constants.js';

/**
 * Search regex pattern 字符长度上限 — 防 user 误传 huge regex 触 catastrophic backtracking.
 * Derivation: 1024 char ≈ 32 复杂 regex token (avg 32 char/token) / 远超 typical regex (≤ 80 char) /
 * 不限制实际可用模式但拦极端 OOM input.
 */
const PATTERN_MAX_LEN = 1024;

type SkipReason = 'binary' | 'permission' | 'io_error' | 'size_limit';

interface FilenameMatch {
  path: string;
}

interface ContentMatch {
  path: string;
  line: number;
  text: string;
}

interface SkipEntry {
  path: string;
  reason: SkipReason;
}

interface WalkResult {
  filenameMatches: FilenameMatch[];
  contentMatches: ContentMatch[];
  skips: SkipEntry[];
}

function isExcludedName(name: string): boolean {
  return SEARCH_DEFAULT_EXCLUDE.includes(name);
}

function classifyError(err: unknown): SkipReason {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return 'permission';
  }
  return 'io_error';
}

function isBinaryContent(content: string): boolean {
  const limit = Math.min(content.length, SEARCH_BINARY_DETECT_BYTES);
  for (let i = 0; i < limit; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

function matchesPattern(haystack: string, pattern: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return haystack.includes(pattern);
  return haystack.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Walk directory recursively. Collects filename matches, content matches, and skip entries.
 * Excludes default exclude paths unless caller's `searchRoot` itself dives into one.
 */
async function walk(
  fs: FileSystem,
  baseDir: string,
  searchRoot: string,
  pattern: string,
  caseSensitive: boolean,
  result: WalkResult,
  relPrefix = '',
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const dirAbs = relPrefix ? nodePath.join(baseDir, relPrefix) : baseDir;
  let dirents;
  try {
    dirents = await fs.list(dirAbs, { includeDirs: true });
  } catch (err) {
    if (!isFileNotFound(err)) {
      result.skips.push({ path: relPrefix || '.', reason: classifyError(err) });
    }
    return;
  }

  const normalizedPrefix = relPrefix.replace(/\/+$/, '');
  for (const d of dirents) {
    if (signal?.aborted) return;
    const childRel = normalizedPrefix ? `${normalizedPrefix}/${d.name}` : d.name;

    // Exclude default scaffolding dirs unless user's searchRoot already dived in.
    if (d.isDirectory && isExcludedName(d.name) && !searchRoot.split(nodePath.sep).includes(d.name)) continue;

    if (d.isDirectory) {
      await walk(fs, baseDir, searchRoot, pattern, caseSensitive, result, childRel, signal);
      continue;
    }

    if (matchesPattern(d.name, pattern, caseSensitive)) {
      result.filenameMatches.push({ path: childRel });
    }

    const fileAbs = nodePath.join(baseDir, childRel);
    let stat;
    try {
      stat = await fs.stat(fileAbs);
    } catch (err) {
      result.skips.push({ path: childRel, reason: classifyError(err) });
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_SIZE) {
      result.skips.push({ path: childRel, reason: 'size_limit' });
      continue;
    }

    let content: string;
    try {
      content = await fs.read(fileAbs);
    } catch (err) {
      result.skips.push({ path: childRel, reason: classifyError(err) });
      continue;
    }

    if (isBinaryContent(content)) {
      result.skips.push({ path: childRel, reason: 'binary' });
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) return;
      if (matchesPattern(lines[i], pattern, caseSensitive)) {
        result.contentMatches.push({ path: childRel, line: i + 1, text: lines[i].trim() });
      }
    }
  }
}

/**
 * Skipped 段渲染。`limit === undefined` 表示完整模式（artifact 用）：列出**全部**明细，
 * 绝不出现「+N more」省略标记；给定 limit 时只列前 limit 条，且**仅在确有省略时**追加
 * `- +N more`。两模式共用同一份 reason 计数（基于完整集合）。
 */
function renderSkips(skips: SkipEntry[], limit?: number): string {
  if (skips.length === 0) return '';
  const counts: Record<SkipReason, number> = { binary: 0, permission: 0, io_error: 0, size_limit: 0 };
  for (const s of skips) counts[s.reason]++;
  const parts: string[] = [];
  for (const k of Object.keys(counts) as SkipReason[]) {
    if (counts[k] > 0) parts.push(`${k}=${counts[k]}`);
  }
  const header = `[Skipped] (${skips.length} files, reasons: ${parts.join(', ')})`;
  const shown = limit === undefined ? skips : skips.slice(0, limit);
  const lines = shown.map(s => `- ${s.path} (${s.reason})`);
  const omitted = skips.length - shown.length;
  if (omitted > 0) lines.push(`- +${omitted} more`);
  return [header, ...lines].join('\n');
}

/* ---------------- phase 2086 Step C：有界预览（行 / 总字节预算） ---------------- */

/** 单行渲染被截短时的显式标记（其字节数在 2KiB 行上限内预留） */
const LINE_TRUNCATION_MARKER = ' … [truncated]';
/** 整份正文被总预算截短时的显式标记（计入 16KiB 总预算） */
const BODY_TRUNCATION_MARKER = '\n… [truncated]';
/** 正文与 footer 之间固定分隔（计入总预算） */
const SECTION_SEPARATOR = '\n\n';
/** footer 内故障文本的显示上限：完整诊断仍进 audit，不在正文里无限膨胀 */
const FOOTER_ERROR_MAX_BYTES = 256;
/** footer 自身放不下时的固定短错误（不含动态路径，长度固定有界） */
const BUDGET_ERROR_MESSAGE = 'search: preview unavailable — the full result was saved, but its artifact path does not fit the output byte budget; see audit log for the path.';

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

interface RenderBlock {
  header: string;
  lines: string[];
}

interface RenderState {
  lineTruncated: boolean;
}

/**
 * 单行 ≤ 上限；超限时先为标记预留字节，再用 truncateUtf8Prefix 按完整码点截取
 * （不产生孤立 surrogate）。
 */
function capRenderedLine(line: string, lineMaxBytes: number | undefined, state: RenderState): string {
  if (lineMaxBytes === undefined) return line;
  if (utf8Bytes(line) <= lineMaxBytes) return line;
  state.lineTruncated = true;
  const budget = Math.max(0, lineMaxBytes - utf8Bytes(LINE_TRUNCATION_MARKER));
  return truncateUtf8Prefix(line, budget) + LINE_TRUNCATION_MARKER;
}

function toDisplayPath(p: string, workspaceClawDirRel: string | null): string {
  // Strip clawPrefix-aware processing: paths in result already include any [clawId] prefix
  // (or none for same-claw). For same-claw, strip workspace-relative prefix.
  if (workspaceClawDirRel && (p === workspaceClawDirRel || p.startsWith(workspaceClawDirRel + '/'))) {
    return p === workspaceClawDirRel ? '.' : p.slice(workspaceClawDirRel.length + 1);
  }
  return p;
}

/**
 * 渲染模式（显式传播 preview / full 意图）。
 * - full：artifact 用，绝不裁剪——既无行字节上限，也无 Skipped 条数上限。
 * - preview：预览用，行 ≤ lineMaxBytes、Skipped 明细 ≤ skipLimit，二者**显式**成对给出。
 * 一律不用某个字段的 undefined 隐式代表另一种模式，避免后续调整行预算时重新把完整输出混用为预览。
 */
type RenderMode =
  | { mode: 'full' }
  | { mode: 'preview'; lineMaxBytes: number; skipLimit: number };

function lineCapOf(renderMode: RenderMode): number | undefined {
  return renderMode.mode === 'full' ? undefined : renderMode.lineMaxBytes;
}

function skipLimitOf(renderMode: RenderMode): number | undefined {
  return renderMode.mode === 'full' ? undefined : renderMode.skipLimit;
}

/**
 * 分段渲染（Filename / Content / Skipped）。full 模式输出完整内容（artifact 用，绝不裁剪）；
 * preview 模式逐行裁剪且 Skipped 明细限流，供预览使用。
 */
function renderBlocks(
  result: WalkResult,
  workspaceClawDirRel: string | null,
  renderMode: RenderMode,
): { blocks: RenderBlock[]; state: RenderState } {
  const lineMaxBytes = lineCapOf(renderMode);
  const state: RenderState = { lineTruncated: false };
  const blocks: RenderBlock[] = [];

  if (result.filenameMatches.length > 0) {
    blocks.push({
      header: '[Filename matches]',
      lines: result.filenameMatches.map(f =>
        capRenderedLine(`- ${toDisplayPath(f.path, workspaceClawDirRel)}`, lineMaxBytes, state)),
    });
  }

  if (result.contentMatches.length > 0) {
    const lines: string[] = [];
    let lastPath = '';
    for (const c of result.contentMatches) {
      const displayPath = toDisplayPath(c.path, workspaceClawDirRel);
      if (displayPath !== lastPath) {
        lines.push(capRenderedLine(displayPath, lineMaxBytes, state));
        lastPath = displayPath;
      }
      lines.push(capRenderedLine(`  ${c.line}: ${c.text}`, lineMaxBytes, state));
    }
    blocks.push({ header: '[Content matches]', lines });
  }

  const skipBlock = renderSkips(result.skips, skipLimitOf(renderMode));
  if (skipBlock) {
    const [header, ...lines] = skipBlock.split('\n');
    blocks.push({ header, lines: lines.map(l => capRenderedLine(l, lineMaxBytes, state)) });
  }

  return { blocks, state };
}

function joinBlocks(blocks: RenderBlock[]): string {
  return blocks.map(b => [b.header, ...b.lines].join('\n')).join(SECTION_SEPARATOR);
}

/** 完整 artifact 内容：不裁剪、不复用预览结果（显式 full 模式 → 全部 Skipped 明细） */
function buildFullOutput(result: WalkResult, workspaceClawDirRel: string | null): string {
  return joinBlocks(renderBlocks(result, workspaceClawDirRel, { mode: 'full' }).blocks);
}

function buildNoMatchBody(
  pattern: string,
  skips: SkipEntry[],
  renderMode: RenderMode,
): { text: string; state: RenderState } {
  const body = `No matches for "${pattern}".`;
  if (skips.length === 0) return { text: body, state: { lineTruncated: false } };
  const state: RenderState = { lineTruncated: false };
  const [header, ...lines] = renderSkips(skips, skipLimitOf(renderMode)).split('\n');
  const capped = [header, ...lines.map(l => capRenderedLine(l, lineCapOf(renderMode), state))].join('\n');
  return { text: `${body}${SECTION_SEPARATOR}${capped}`, state };
}

function takePreview(result: WalkResult): WalkResult {
  const previewFilename: FilenameMatch[] = [];
  const previewContent: ContentMatch[] = [];
  let taken = 0;
  for (const f of result.filenameMatches) {
    if (taken >= SEARCH_PREVIEW_LIMIT) break;
    previewFilename.push(f);
    taken++;
  }
  for (const c of result.contentMatches) {
    if (taken >= SEARCH_PREVIEW_LIMIT) break;
    previewContent.push(c);
    taken++;
  }
  return { filenameMatches: previewFilename, contentMatches: previewContent, skips: result.skips };
}

function joinRel(base: string, rel: string): string {
  if (rel === '' || rel === '.') return base === '.' ? '' : base;
  if (base === '' || base === '.') return rel;
  return `${base}/${rel}`;
}

function remapToWorkspace(result: WalkResult, searchPath: string): WalkResult {
  return {
    filenameMatches: result.filenameMatches.map(f => ({ path: joinRel(searchPath, f.path) })),
    contentMatches: result.contentMatches.map(c => ({ path: joinRel(searchPath, c.path), line: c.line, text: c.text })),
    skips: result.skips.map(s => ({ path: joinRel(searchPath, s.path), reason: s.reason })),
  };
}

/**
 * overflow 落盘结果三态（模块私有判别联合，不进 barrel）。
 * - durable：rename + 父目录 fsync 均成功，提交完全持久。
 * - committed_platform_limited / committed_durability_unknown：rename 已成功、内容已提交
 *   可见，仅耐久性未获确认；必须保留 relPath，不得重写或删除 artifact。
 * - failed：rename 前失败（异常），内容未落盘。
 */
type OverflowResult =
  | { kind: 'durable'; relPath: string }
  | { kind: 'committed_platform_limited' | 'committed_durability_unknown'; relPath: string; error: string }
  | { kind: 'failed'; error: string };

async function persistOverflow(ctx: ExecContext, fullContent: string): Promise<OverflowResult> {
  try {
    // phase 2092 Step B：产物写 caller 的输出面（跨 claw 时 ctx.fs 已重绑到 target）。
    // 扫描读取仍用 ctx.fs / ctx.workspaceDir；2086 的三态与有界预览预算完全保留。
    const writeSide = ctx.toolOutput ?? ctx;
    const id = newShortUuid();
    const fullPath = nodePath.join(
      writeSide.syncDir,
      TASKS_SYNC_SEARCH_DIR.split('/').pop()!,
      `${id}.md`,
    );
    const frontmatter = `---\nsource: search_overflow\ncontent_length: ${fullContent.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    const written = await writeSide.fs.writeAtomic(fullPath, frontmatter + fullContent);
    const relPath = nodePath.relative(writeSide.workspaceDir, fullPath);
    if (written.kind === 'durable') return { kind: 'durable', relPath };
    // 已提交但耐久性未确认：artifact 已在 relPath 可见 → 不重写、不删除，只显式交付状态
    const error = formatErr(written.error);
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED,
      `stage=durability`,
      `commit=${written.kind}`,
      `path=${relPath}`,
      `reason=${error}`,
    );
    return { kind: written.kind, relPath, error };
  } catch (err) {
    ctx.auditWriter?.write(FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED, `reason=${formatErr(err)}`);
    return { kind: 'failed', error: formatErr(err) };
  }
}

/**
 * 把正文与 footer 装进 SEARCH_OUTPUT_MAX_BYTES：footer（artifact 路径 + 取回命令 +
 * 状态说明）优先保留，正文按剩余预算裁剪并显式标记。footer 自身放不下 → null，
 * 由调用方返回固定短错误（绝不截断后伪造可用路径）。
 */
function fitContentToBudget(body: string, footer: string): string | null {
  const footerBytes = utf8Bytes(footer);
  if (footerBytes + utf8Bytes(SECTION_SEPARATOR) > SEARCH_OUTPUT_MAX_BYTES) return null;
  const available = SEARCH_OUTPUT_MAX_BYTES - footerBytes - utf8Bytes(SECTION_SEPARATOR);
  if (available <= 0) return footer;
  if (utf8Bytes(body) <= available) return `${body}${SECTION_SEPARATOR}${footer}`;
  const markerBytes = utf8Bytes(BODY_TRUNCATION_MARKER);
  if (available <= markerBytes) return footer;
  return `${truncateUtf8Prefix(body, available - markerBytes)}${BODY_TRUNCATION_MARKER}${SECTION_SEPARATOR}${footer}`;
}

async function finalize(
  ctx: ExecContext,
  pattern: string,
  result: WalkResult,
  workspaceClawDirRel: string | null,
): Promise<ToolResult> {
  const totalMatches = result.filenameMatches.length + result.contentMatches.length;

  // 1) 完整渲染：artifact 唯一权威内容（未裁剪，也不复用下面的预览结果）
  const fullContent = buildFullOutput(result, workspaceClawDirRel);

  // 2) 预览候选：≤SEARCH_PREVIEW_LIMIT 条、每行 ≤SEARCH_PREVIEW_LINE_MAX_BYTES
  const previewResult = takePreview(result);
  const previewMode: RenderMode = {
    mode: 'preview',
    lineMaxBytes: SEARCH_PREVIEW_LINE_MAX_BYTES,
    skipLimit: SEARCH_SKIP_DISPLAY_LIMIT,
  };
  const preview = totalMatches === 0
    ? buildNoMatchBody(pattern, previewResult.skips, previewMode)
    : (() => {
        const rendered = renderBlocks(previewResult, workspaceClawDirRel, previewMode);
        return { text: joinBlocks(rendered.blocks), state: rendered.state };
      })();

  const overCount = totalMatches > SEARCH_PREVIEW_LIMIT;
  const overLineLimit = preview.state.lineTruncated;
  const overTotalBudget = utf8Bytes(preview.text) > SEARCH_OUTPUT_MAX_BYTES;
  // Skipped 明细被截断也算「显示裁剪」：仅条数超限（含零匹配）同样必须落盘一次完整结果
  const overSkipCount = result.skips.length > SEARCH_SKIP_DISPLAY_LIMIT;

  // 3) 短且完整：保持原文本，零落盘
  if (!overCount && !overLineLimit && !overTotalBudget && !overSkipCount) {
    return { success: true, content: preview.text };
  }

  // 4) 任何显示裁剪都先做一次完整结果保存尝试，再按预算拼 footer 与正文
  const overflow = await persistOverflow(ctx, fullContent);
  const limitsNote = `Preview truncated (limits: ${SEARCH_PREVIEW_LIMIT} matches, ${SEARCH_PREVIEW_LINE_MAX_BYTES}B per line, ${SEARCH_OUTPUT_MAX_BYTES}B total).`;
  const previewHeader = totalMatches > 0
    ? `Showing up to ${Math.min(totalMatches, SEARCH_PREVIEW_LIMIT)} of ${totalMatches} matches. `
    : '';

  if (overflow.kind === 'failed') {
    const shortError = truncateUtf8Prefix(overflow.error, FOOTER_ERROR_MAX_BYTES);
    const footer = `${previewHeader}${limitsNote} (overflow persist failed: ${shortError}; ${Math.max(0, totalMatches - SEARCH_PREVIEW_LIMIT)} additional matches not delivered)`;
    const fitted = fitContentToBudget(preview.text, footer);
    // 失败文本自身都放不下时同样只给固定短错误（完整诊断已在 audit）
    return { success: false, content: fitted ?? BUDGET_ERROR_MESSAGE };
  }

  const readCommand = `read({ "path": ${JSON.stringify(overflow.relPath)}, "offset": 1, "limit": 200 })`;
  const durabilityNote = overflow.kind === 'durable'
    ? ''
    : ` (artifact committed but durability unconfirmed: ${overflow.kind}; ${truncateUtf8Prefix(overflow.error, FOOTER_ERROR_MAX_BYTES)})`;
  const footer = `${previewHeader}${limitsNote} Full results saved at ${overflow.relPath}. Use \`read\` to view: ${readCommand}${durabilityNote}`;
  const fitted = fitContentToBudget(preview.text, footer);
  if (fitted === null) {
    // footer 自身放不下（例如异常长路径）：不截断后伪造可用路径 → 固定短错误 + 审计全量路径
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED,
      `stage=output-budget`,
      `commit=${overflow.kind}`,
      `path=${overflow.relPath}`,
      `reason=preview footer exceeds ${SEARCH_OUTPUT_MAX_BYTES}B output budget`,
    );
    return { success: false, content: BUDGET_ERROR_MESSAGE };
  }
  return { success: true, content: fitted };
}

const SEARCH_TOOL_NAME = 'search' as const;

const SearchInputSchema = z.object({
  text: z.string().describe(
    'Literal text to search for (case-insensitive by default, no regex/glob — searched as substring). Non-empty, length <= 1024.'
  ),
  path: z.string().optional().describe(
    'Directory to search in, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. path: "../memory"). Default: clawspace root.'
  ),
  caseSensitive: z.boolean().optional().describe('Match case-sensitively. Default: false.'),
  async: z.boolean().optional().describe('If true, execute in the first parallel batch. Results return in the same turn.'),
}).strict();

type SearchInput = z.infer<typeof SearchInputSchema>;

export const searchTool: Tool = {
  name: SEARCH_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  description: 'Search LOCAL files (not web/network) for literal text in filenames AND contents (unified). Returns segmented [Filename matches] / [Content matches] / [Skipped]. Case-insensitive by default, no regex/glob. Full scan with no match cap, but the response is bounded: at most 20 matches previewed, 2 KiB per rendered line, 16 KiB total. Anything trimmed is saved once to tasks/sync/search/<uuid>.md and the response gives that exact path plus a `read` command starting at offset 1. Default base: clawspace.',
  schema: defineFileToolSchema(SearchInputSchema),
  readonly: true,
  idempotent: true,

  async execute(rawArgs: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    let args: SearchInput;
    try {
      args = SearchInputSchema.parse(rawArgs);
    } catch (err) {
      // phase 692: 拆 tool + error 为两 col、与 phase 690/691 同模式
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.INPUT_VALIDATION_FAILED,
        `tool=search`,
        `error=${formatErr(err)}`,
      );
      return {
        success: false,
        content: `search tool input validation failed: ${(err as Error).message}`,
      };
    }

    const rawText = args.text;
    if (rawText.length === 0) {
      return { success: false, content: 'Error: text must be a non-empty string' };
    }
    if (rawText.length > PATTERN_MAX_LEN) {
      return { success: false, content: `Error: text length exceeds ${PATTERN_MAX_LEN}` };
    }
    const pattern = rawText;
    const caseSensitive = args.caseSensitive === true;

    const pathArg = args.path ?? '.';
    const searchPath = resolveWorkspacePath(ctx, pathArg);
    if (searchPath.startsWith('..') || searchPath.startsWith('/')) {
      return {
        success: false,
        content: `Error: Path escapes claw root: "${pathArg}"`,
      };
    }

    const checker = ctx.permissionChecker;
    if (!checker) {
      throw new Error('FileTool.search: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(searchPath, 'read');

    const result: WalkResult = { filenameMatches: [], contentMatches: [], skips: [] };
    await walk(ctx.fs, searchPath, searchPath, pattern, caseSensitive, result, '', ctx.signal);

    const workspaceClawDirRel = nodePath.relative(ctx.clawDir, ctx.workspaceDir);
    const remapped = remapToWorkspace(result, searchPath);
    return await finalize(ctx, pattern, remapped, workspaceClawDirRel);
  },
};
