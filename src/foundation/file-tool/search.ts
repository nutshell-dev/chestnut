/**
 * @module L2.FileTool
 * search tool - Search for text in files
 *
 * Path restrictions (MVP aligned):
 * - Whitelist: clawspace/, skills/, prompts/
 * 
 * Motion-only: can search other claws' files via `claw` parameter
 */

import * as nodePath from 'path';
import * as fsNative from 'fs';
import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import { getChecker } from './permission-context.js';

// Allowed paths/prefixes for search tool (MVP aligned)
const SEARCH_ALLOWLIST = [
  'clawspace/',   // 工作产出（最主要用途）
  'skills/',      // 技能定义
  'prompts/',     // prompt 模板
];

function isSearchPathAllowed(searchPath: string): boolean {
  // Normalize path: add trailing slash for directory checks
  const normalizedPath = searchPath.endsWith('/') ? searchPath : searchPath + '/';
  return SEARCH_ALLOWLIST.some(allowed => 
    searchPath === allowed || normalizedPath.startsWith(allowed)
  );
}

/**
 * Walk directory recursively and search for query in files.
 * Calls onMatch for each match found, onSkip for files that can't be read.
 */
async function walkNative(
  baseDir: string,
  query: string,
  remaining: number,
  onMatch: (relPath: string, lineNo: number, line: string) => void,
  onSkip: () => void,
  prefix = ''
): Promise<number> {
  let rem = remaining;
  const dirents = await fsNative.promises.readdir(baseDir, { withFileTypes: true });
  for (const d of dirents) {
    if (rem <= 0) return rem;
    const relPath = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      rem = await walkNative(nodePath.join(baseDir, d.name), query, rem, onMatch, onSkip, relPath);
    } else {
      try {
        const lines = (await fsNative.promises.readFile(nodePath.join(baseDir, relPath), 'utf-8')).split('\n');
        for (let i = 0; i < lines.length && rem > 0; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            onMatch(relPath, i + 1, lines[i].trim());
            rem--;
          }
        }
      } catch {
        onSkip();
      }
    }
  }
  return rem;
}

import { SEARCH_TOOL_NAME } from '../tools/tool-names.js';
export { SEARCH_TOOL_NAME };

export const searchTool: Tool = {
  name: SEARCH_TOOL_NAME,
  description: 'Search for text in LOCAL files only (not web/network). Returns file:line: content matches, case-insensitive, default max 5 results. Allowed paths: clawspace/, skills/, prompts/. Motion can search another claw via `claw: "<id>"`, or all claws via `claw: "*"`.',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for (case-insensitive)',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (defaults to clawspace/, allowed: clawspace/, skills/, prompts/)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default 5)',
      },
      claw: {
        type: 'string',
        description: '目标 claw ID（仅 Motion 可用）。"*" 表示搜索所有 claw，结果带 [clawId] 前缀。例：{ query: "error", path: "logs/", claw: "*" }',
      },
      async: {
        type: 'boolean',
        description: 'If true, run in background. Result delivered to inbox when complete. Use for large searches or non-blocking queries.',
      },
    },
    required: ['query'],
  },
  readonly: true,
  idempotent: true,
  supportsAsync: true,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const query = (args.query as string).toLowerCase();
    const searchPath = (args.path as string) ?? 'clawspace/';
    const maxResults = (args.max_results as number) ?? 5;
    const clawParam = args.claw as string | undefined;

    // Phase430: claw-space boundary check — caller autonomy
    const checker = getChecker(ctx.clawDir);
    checker.resolveAndCheck(searchPath, 'read');

    // Motion-only: search files in another claw
    let baseDir: string;
    let useNativeFs = false;

    if (clawParam !== undefined) {
      // Only Motion can use this feature
      if (!ctx.isMotionChain) {
        return {
          success: false,
          content: 'Error: Only Motion and its subagents can search files from other claws',
        };
      }

      // claw: "*" - search all claws
      if (clawParam === '*') {
        const clawsDir = nodePath.resolve(ctx.clawDir, '..', 'claws');
        let clawIds: string[];
        try {
          clawIds = fsNative.readdirSync(clawsDir).filter(name =>
            fsNative.statSync(nodePath.join(clawsDir, name)).isDirectory() && !name.startsWith('.')
          );
          clawIds.sort(); // 保证稳定顺序
        } catch {
          return { success: true, content: `未找到包含 "${args.query}" 的内容（无 claw 目录）` };
        }

        const allResults: string[] = [];
        let totalSkipped = 0;

        for (const clawId of clawIds) {
          if (allResults.length >= maxResults) break;
          const clawBaseDir = nodePath.join(clawsDir, clawId, searchPath);
          if (!fsNative.existsSync(clawBaseDir)) continue;

          try {
            await walkNative(
              clawBaseDir,
              query,
              maxResults - allResults.length,
              (relPath, lineNo, line) => {
                allResults.push(`[${clawId}] ${searchPath}${relPath}:${lineNo}: ${line}`);
              },
              () => { totalSkipped++; }
            );
          } catch { /* claw dir not accessible */ }
        }

        const skippedMsg = totalSkipped > 0 ? `（${totalSkipped} 个文件被跳过）` : '';
        if (allResults.length === 0) {
          return { success: true, content: `未找到包含 "${args.query}" 的内容${skippedMsg}` };
        }
        return { success: true, content: allResults.join('\n') + skippedMsg };
      }

      // Validate clawParam (no path traversal)
      if (clawParam.includes('/') || clawParam.includes('..') || clawParam === '' || clawParam === '.' || clawParam.startsWith('.')) {
        return {
          success: false,
          content: `Error: Invalid claw ID: "${clawParam}"`,
        };
      }
      // Resolve path to target claw's directory
      baseDir = nodePath.resolve(ctx.clawDir, '..', 'claws', clawParam, searchPath);
      // Escape check: must be within the target claw's directory
      const clawsDir = nodePath.resolve(ctx.clawDir, '..', 'claws');
      const clawRoot = nodePath.join(clawsDir, clawParam);
      if (baseDir !== clawRoot && !baseDir.startsWith(clawRoot + nodePath.sep)) {
        return {
          success: false,
          content: `Error: Path escapes target claw directory: "${searchPath}"`,
        };
      }
      // Skip whitelist check for cross-claw search (Motion has full access)
      useNativeFs = true;
    } else {
      // Normal search (with whitelist)
      // Path restriction check (MVP aligned)
      if (!isSearchPathAllowed(searchPath)) {
        return {
          success: false,
          content: `Error: Path "${searchPath}" is not allowed for search. Allowed: clawspace/, skills/, prompts/.`,
        };
      }
      baseDir = searchPath;
    }

    const results: string[] = [];
    let skippedCount = 0; // Design doc: track skipped files

    try {
      // Get all files in the search path
      let entries: { path: string; isDirectory: boolean; isFile: boolean }[];
      
      if (useNativeFs) {
        // Use walkNative for single claw search
        await walkNative(
          baseDir,
          query,
          maxResults,
          (relPath, lineNo, line) => {
            results.push(`${relPath}:${lineNo}: ${line}`);
          },
          () => { skippedCount++; }
        );
        
        const skippedMsg = skippedCount > 0 ? `（${skippedCount} 个文件被跳过）` : '';
        if (results.length === 0) {
          return {
            success: true,
            content: `未找到包含 "${args.query}" 的内容${skippedMsg}`,
          };
        }
        return {
          success: true,
          content: results.join('\n') + skippedMsg,
        };
      } else {
        entries = await ctx.fs.list(baseDir, { recursive: true, includeDirs: false });
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        try {
          let content: string;
          content = await ctx.fs.read(entry.path);
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;

            if (lines[i].toLowerCase().includes(query)) {
              results.push(`${entry.path}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        } catch {
          // Skip files that can't be read
          skippedCount++;
          continue;
        }
      }
    } catch (error) {
      return {
        success: false,
        content: `Error searching: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const skippedMsg = skippedCount > 0 ? `（${skippedCount} 个文件被跳过）` : '';
    
    if (results.length === 0) {
      return {
        success: true,
        content: `未找到包含 "${args.query}" 的内容${skippedMsg}`,
      };
    }

    return {
      success: true,
      content: results.join('\n') + skippedMsg,
    };
  },
};
