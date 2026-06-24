/**
 * @module L2c.FileTool
 * search tool — unified filename + content substring search.
 *
 * phase 1422: design 落地（Q1 pattern + Q2 unified + Q3 skip 分类 + Q4 binary detect
 * + default exclude + Q5 全英 + Q6 全扫 / overflow 落盘 / 预览 20 + Q7 cross-claw prefix）。
 */

import { newShortUuid } from  '../node-utils/index.js';
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

function renderSkips(skips: SkipEntry[]): string {
  if (skips.length === 0) return '';
  const counts: Record<SkipReason, number> = { binary: 0, permission: 0, io_error: 0, size_limit: 0 };
  for (const s of skips) counts[s.reason]++;
  const parts: string[] = [];
  for (const k of Object.keys(counts) as SkipReason[]) {
    if (counts[k] > 0) parts.push(`${k}=${counts[k]}`);
  }
  const header = `[Skipped] (${skips.length} files, reasons: ${parts.join(', ')})`;
  const head = skips.slice(0, SEARCH_SKIP_DISPLAY_LIMIT)
    .map(s => `- ${s.path} (${s.reason})`)
    .join('\n');
  const more = skips.length > SEARCH_SKIP_DISPLAY_LIMIT
    ? `\n- +${skips.length - SEARCH_SKIP_DISPLAY_LIMIT} more`
    : '';
  return `${header}\n${head}${more}`;
}

function renderResults(
  result: WalkResult,
  workspaceClawDirRel: string | null,
): { filename: string[]; content: string[] } {
  const filenameLines: string[] = [];
  const contentLines: string[] = [];

  const toDisplay = (p: string): string => {
    // Strip clawPrefix-aware processing: paths in result already include any [clawId] prefix
    // (or none for same-claw). For same-claw, strip workspace-relative prefix.
    if (workspaceClawDirRel && (p === workspaceClawDirRel || p.startsWith(workspaceClawDirRel + '/'))) {
      return p === workspaceClawDirRel ? '.' : p.slice(workspaceClawDirRel.length + 1);
    }
    return p;
  };

  for (const f of result.filenameMatches) {
    filenameLines.push(`- ${toDisplay(f.path)}`);
  }

  let lastPath = '';
  for (const c of result.contentMatches) {
    const displayPath = toDisplay(c.path);
    if (displayPath !== lastPath) {
      contentLines.push(displayPath);
      lastPath = displayPath;
    }
    contentLines.push(`  ${c.line}: ${c.text}`);
  }

  return { filename: filenameLines, content: contentLines };
}

async function persistOverflow(
  ctx: ExecContext,
  fullContent: string,
): Promise<{ relPath: string | null; error: string | null }> {
  try {
    const id = newShortUuid();
    const fullPath = nodePath.join(
      ctx.syncDir,
      TASKS_SYNC_SEARCH_DIR.split('/').pop()!,
      `${id}.md`,
    );
    const frontmatter = `---\nsource: search_overflow\ncontent_length: ${fullContent.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + fullContent);
    return { relPath: nodePath.relative(ctx.workspaceDir, fullPath), error: null };
  } catch (err) {
    ctx.auditWriter?.write(FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED, `reason=${formatErr(err)}`);
    return { relPath: null, error: formatErr(err) };
  }
}

function buildFullOutput(
  result: WalkResult,
  workspaceClawDirRel: string | null,
): string {
  const rendered = renderResults(result, workspaceClawDirRel);
  const sections: string[] = [];
  if (rendered.filename.length > 0) {
    sections.push(['[Filename matches]', ...rendered.filename].join('\n'));
  }
  if (rendered.content.length > 0) {
    sections.push(['[Content matches]', ...rendered.content].join('\n'));
  }
  const skipBlock = renderSkips(result.skips);
  if (skipBlock) sections.push(skipBlock);
  return sections.join('\n\n');
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

async function finalize(
  ctx: ExecContext,
  pattern: string,
  result: WalkResult,
  workspaceClawDirRel: string | null,
): Promise<ToolResult> {
  const totalMatches = result.filenameMatches.length + result.contentMatches.length;

  if (totalMatches === 0) {
    const skipBlock = renderSkips(result.skips);
    const body = `No matches for "${pattern}".`;
    return { success: true, content: skipBlock ? `${body}\n\n${skipBlock}` : body };
  }

  if (totalMatches <= SEARCH_PREVIEW_LIMIT) {
    return { success: true, content: buildFullOutput(result, workspaceClawDirRel) };
  }

  const fullContent = buildFullOutput(result, workspaceClawDirRel);
  const overflow = await persistOverflow(ctx, fullContent);
  const preview = buildFullOutput(takePreview(result), workspaceClawDirRel);
  const overflowFooter = overflow.relPath !== null
    ? `Showing 1-${SEARCH_PREVIEW_LIMIT} of ${totalMatches} matches. Full results saved at ${overflow.relPath}. Use \`read\` to view: read({ "path": "${overflow.relPath}", "offset": ${SEARCH_PREVIEW_LIMIT + 1}, "limit": 200 })`
    : `Showing 1-${SEARCH_PREVIEW_LIMIT} of ${totalMatches} matches. (overflow persist failed: ${overflow.error}; ${totalMatches - SEARCH_PREVIEW_LIMIT} additional matches lost)`;

  return { success: true, content: `${preview}\n\n${overflowFooter}` };
}

export const SEARCH_TOOL_NAME = 'search' as const;

const SearchInputSchema = z.object({
  text: z.string().describe(
    'Literal text to search for (case-insensitive by default, no regex/glob — searched as substring). Non-empty, length <= 1024.'
  ),
  path: z.string().optional().describe(
    'Directory to search in, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. path: "../memory"). Default: clawspace root.'
  ),
  caseSensitive: z.boolean().optional().describe('Match case-sensitively. Default: false.'),
  async: z.boolean().optional().describe('If true, run in background. Result delivered to inbox when complete.'),
}).strict();

type SearchInput = z.infer<typeof SearchInputSchema>;

export const searchTool: Tool = {
  name: SEARCH_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: 'Search LOCAL files (not web/network) for literal text in filenames AND contents (unified). Returns segmented [Filename matches] / [Content matches] / [Skipped]. Case-insensitive by default, no regex/glob. Full scan with no result cap; first 20 returned as preview, overflow saved to tasks/sync/search/<uuid>.md. Default base: clawspace.',
  schema: defineFileToolSchema(SearchInputSchema),
  readonly: true,
  idempotent: true,
  supportsAsync: true,

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
