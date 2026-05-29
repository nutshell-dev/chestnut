/**
 * @module L2.FileTool
 * search tool — unified filename + content substring search.
 *
 * phase 1422: design 落地（Q1 pattern + Q2 unified + Q3 skip 分类 + Q4 binary detect
 * + default exclude + Q5 全英 + Q6 全扫 / overflow 落盘 / 预览 20 + Q7 cross-claw prefix）。
 *
 * Cross-claw access: `claw: "<id>"` available to all agents; `claw: "*"` (broadcast) Motion-only (per D11).
 */

import { randomUUID } from 'crypto';
import * as nodePath from 'path';
import { isFileNotFound, type FileSystem } from '../fs/types.js';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { CLAWS_DIR } from '../paths.js';
import { formatErr } from '../utils/format.js';
import { UUID_SHORT_LEN } from '../../constants.js';
import {
  TASKS_SYNC_SEARCH_DIR,
  SEARCH_PREVIEW_LIMIT,
  SEARCH_BINARY_DETECT_BYTES,
  SEARCH_MAX_FILE_SIZE,
  SEARCH_DEFAULT_EXCLUDE,
  SEARCH_SKIP_DISPLAY_LIMIT,
} from './constants.js';

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
    const id = randomUUID().slice(0, UUID_SHORT_LEN);
    const fullPath = nodePath.join(
      ctx.syncDir,
      TASKS_SYNC_SEARCH_DIR.split('/').pop()!,
      `${id}.md`,
    );
    const frontmatter = `---\nsource: search_overflow\ncontent_length: ${fullContent.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + fullContent);
    return { relPath: nodePath.relative(ctx.workspaceDir, fullPath), error: null };
  } catch (err) {
    ctx.auditWriter?.write('search_overflow_persist_failed', `reason=${formatErr(err)}`);
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

function prefixPaths(result: WalkResult, prefix: string): WalkResult {
  if (!prefix) return result;
  return {
    filenameMatches: result.filenameMatches.map(f => ({ path: prefix + f.path })),
    contentMatches: result.contentMatches.map(c => ({ path: prefix + c.path, line: c.line, text: c.text })),
    skips: result.skips.map(s => ({ path: prefix + s.path, reason: s.reason })),
  };
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

export const searchTool: Tool = {
  name: SEARCH_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: 'Search LOCAL files (not web/network) for a substring pattern in filenames AND contents (unified). Returns segmented [Filename matches] / [Content matches] / [Skipped]. Case-insensitive by default. Full scan with no result cap; first 20 returned as preview, overflow saved to tasks/sync/search/<uuid>.md. Default base: clawspace. `claw: "<id>"` searches another claw\'s resources (read-only); `claw: "*"` broadcast across all claws is Motion-only.',
  schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Substring to search for (case-insensitive by default, no regex/glob). Non-empty, length <= 1024.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in, relative to clawspace. Default: clawspace root.',
      },
      cwd: {
        type: 'string',
        description: 'Override base for path resolution, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. cwd: "../memory"). Default: clawspace.',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Match case-sensitively. Default: false.',
      },
      claw: {
        type: 'string',
        description: 'Target claw ID (specific target: any agent; "*" broadcast: Motion only). Both prefix matches with [clawId]. Example: { pattern: "error", path: "logs/", claw: "*" }',
      },
      async: {
        type: 'boolean',
        description: 'If true, run in background. Result delivered to inbox when complete.',
      },
    },
    required: ['pattern'],
  },
  readonly: true,
  idempotent: true,
  supportsAsync: true,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const rawPattern = args.pattern as string;
    if (typeof rawPattern !== 'string' || rawPattern.length === 0) {
      return { success: false, content: 'Error: pattern must be a non-empty string' };
    }
    if (rawPattern.length > PATTERN_MAX_LEN) {
      return { success: false, content: `Error: pattern length exceeds ${PATTERN_MAX_LEN}` };
    }
    const pattern = rawPattern;
    const caseSensitive = args.caseSensitive === true;

    const pathArg = (args.path as string) ?? '.';
    const cwdArg = args.cwd as string | undefined;
    const searchPath = resolveWorkspacePath(ctx, pathArg, cwdArg);
    if (searchPath.startsWith('..') || searchPath.startsWith('/')) {
      return {
        success: false,
        content: `Error: Path escapes claw root: "${pathArg}"${cwdArg ? ` (cwd: ${cwdArg})` : ''}`,
      };
    }

    const checker = ctx.permissionChecker;
    if (!checker) {
      throw new Error('FileTool.search: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(searchPath, 'read');

    const clawParam = args.claw as string | undefined;

    // ── cross-claw branch ──────────────────────────────────────────────
    if (clawParam !== undefined) {
      if (!ctx.fsFactory) {
        return { success: false, content: 'Error: Cross-claw access not available in this context (fsFactory not injected)' };
      }

      // claw: "*" broadcast
      if (clawParam === '*') {
        if (!ctx.isMotionChain) {
          return { success: false, content: 'Error: claw: "*" broadcast is Motion-only. Use claw: "<id>" for specific claw access.' };
        }
        const clawsDir = nodePath.join(ctx.clawforumRoot, CLAWS_DIR);
        const clawforumFs = ctx.fsFactory(clawsDir);
        let clawIds: string[];
        try {
          clawIds = clawforumFs.listSync('', { includeDirs: true })
            .filter(e => e.isDirectory && !e.name.startsWith('.'))
            .map(e => e.name)
            .sort();
        } catch {
          return { success: true, content: `No matches for "${pattern}".` };
        }

        const aggregate: WalkResult = { filenameMatches: [], contentMatches: [], skips: [] };
        const rawSearchPath = nodePath.normalize(pathArg);

        for (const clawId of clawIds) {
          if (ctx.signal?.aborted) break;
          const clawFs = ctx.fsFactory(nodePath.join(clawsDir, clawId));
          if (!clawFs.existsSync(rawSearchPath)) continue;

          const perClaw: WalkResult = { filenameMatches: [], contentMatches: [], skips: [] };
          try {
            // baseDir = clawRoot, start walk inside rawSearchPath so paths come out as
            // `<rawSearchPath>/...` keeping user's mental model (they typed path: 'clawspace/').
            await walk(clawFs, '', rawSearchPath, pattern, caseSensitive, perClaw, rawSearchPath, ctx.signal);
          } catch (err) {
            if (!isFileNotFound(err)) {
              ctx.auditWriter?.write('broadcast_claw_skipped', `claw=${clawId}`, `reason=${formatErr(err)}`);
            }
            continue;
          }
          const prefixed = prefixPaths(perClaw, `[${clawId}] `);
          aggregate.filenameMatches.push(...prefixed.filenameMatches);
          aggregate.contentMatches.push(...prefixed.contentMatches);
          aggregate.skips.push(...prefixed.skips);
        }

        return await finalize(ctx, pattern, aggregate, null);
      }

      // claw: "<id>" specific target
      if (clawParam.includes('/') || clawParam.includes('..') || clawParam === '' || clawParam === '.' || clawParam.startsWith('.')) {
        return { success: false, content: `Error: Invalid claw ID: "${clawParam}"` };
      }
      const rawSearchPath = nodePath.normalize(pathArg);
      const clawsDir = nodePath.join(ctx.clawforumRoot, CLAWS_DIR);
      const clawRoot = nodePath.join(clawsDir, clawParam);
      const baseDir = nodePath.resolve(clawRoot, rawSearchPath);
      if (baseDir !== clawRoot && !baseDir.startsWith(clawRoot + nodePath.sep)) {
        return { success: false, content: `Error: Path escapes target claw root: "${rawSearchPath}"` };
      }

      const targetFs = ctx.fsFactory(clawRoot);
      const result: WalkResult = { filenameMatches: [], contentMatches: [], skips: [] };
      await walk(targetFs, '', rawSearchPath, pattern, caseSensitive, result, rawSearchPath, ctx.signal);

      return await finalize(ctx, pattern, prefixPaths(result, `[${clawParam}] `), null);
    }

    // ── same-claw branch ───────────────────────────────────────────────
    const result: WalkResult = { filenameMatches: [], contentMatches: [], skips: [] };
    await walk(ctx.fs, searchPath, searchPath, pattern, caseSensitive, result, '', ctx.signal);

    const workspaceClawDirRel = nodePath.relative(ctx.clawDir, ctx.workspaceDir);
    const remapped = remapToWorkspace(result, searchPath);
    return await finalize(ctx, pattern, remapped, workspaceClawDirRel);
  },
};

