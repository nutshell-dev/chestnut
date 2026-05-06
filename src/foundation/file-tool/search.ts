/**
 * @module L2.FileTool
 * search tool - Search for text in files
 *
 * Motion-only: can search other claws' files via `claw` parameter
 */

import * as nodePath from 'path';
import { NodeFileSystem } from '../fs/node-fs.js';
import type { FileSystem } from '../fs/types.js';
import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import { getChecker } from './permission-context.js';

/**
 * Walk directory recursively and search for query in files.
 * Calls onMatch for each match found, onSkip for files that can't be read.
 */
async function walkNative(
  fs: FileSystem,
  baseDir: string,
  query: string,
  remaining: number,
  onMatch: (relPath: string, lineNo: number, line: string) => void,
  onSkip: () => void,
  prefix = ''
): Promise<number> {
  let rem = remaining;
  const dirents = await fs.list(baseDir, { includeDirs: true });
  for (const d of dirents) {
    if (rem <= 0) return rem;
    const relPath = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory) {
      rem = await walkNative(fs, nodePath.join(baseDir, d.name), query, rem, onMatch, onSkip, relPath);
    } else {
      try {
        const lines = (await fs.read(nodePath.join(baseDir, relPath))).split('\n');
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
  description: 'Search for text in LOCAL files only (not web/network). Returns file:line: content matches, case-insensitive, default max 5 results. Default search path: agent workspace dir. Use `claw: "<id>"` to search another claw\'s resources (read-only). `claw: "*"` (broadcast across all claws) is Motion-only.',
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
    const searchPath = (args.path as string) ?? nodePath.relative(ctx.clawDir, ctx.workspaceDir) + '/';  // phase 512 / main=clawspace/ / subagent=tasks/subagents/<id>/
    const maxResults = (args.max_results as number) ?? 5;
    const clawParam = args.claw as string | undefined;

    // Phase430: claw-space boundary check — caller autonomy
    const checker = getChecker(ctx.clawDir);
    checker.resolveAndCheck(searchPath, 'read');

    // Motion-only: search files in another claw
    let baseDir: string;
    let useNativeFs = false;

    if (clawParam !== undefined) {
      // claw: "*" - search all claws
      if (clawParam === '*') {
        // claw: '*' broadcast 限 Motion / specific target 任意（D11 互访 align）
        if (!ctx.isMotionChain) {
          return {
            success: false,
            content: 'Error: claw: "*" broadcast is Motion-only. Use claw: "<id>" for specific claw access.',
          };
        }
        const clawsDir = nodePath.resolve(ctx.clawDir, '..', 'claws');
        const clawforumFs = new NodeFileSystem({ baseDir: clawsDir });
        let clawIds: string[];
        try {
          clawIds = clawforumFs.listSync('', { includeDirs: true })
            .filter(e => e.isDirectory && !e.name.startsWith('.'))
            .map(e => e.name);
          clawIds.sort(); // 保证稳定顺序
        } catch {
          return { success: true, content: `未找到包含 "${args.query}" 的内容（无 claw 目录）` };
        }

        const allResults: string[] = [];
        let totalSkipped = 0;

        for (const clawId of clawIds) {
          if (allResults.length >= maxResults) break;
          const clawBaseDir = nodePath.join(clawsDir, clawId, searchPath);
          const clawFs = new NodeFileSystem({ baseDir: nodePath.join(clawsDir, clawId) });
          if (!clawFs.existsSync(searchPath)) continue;

          try {
            await walkNative(
              clawFs,
              searchPath,
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
      baseDir = searchPath;
    }

    const results: string[] = [];
    let skippedCount = 0; // Design doc: track skipped files

    try {
      // Get all files in the search path
      let entries: { path: string; isDirectory: boolean; isFile: boolean }[];
      
      if (useNativeFs) {
        // Use walkNative for single claw search
        const targetFs = new NodeFileSystem({ baseDir: nodePath.resolve(ctx.clawDir, '..', 'claws', clawParam!) });
        await walkNative(
          targetFs,
          searchPath,
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
