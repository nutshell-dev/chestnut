/**
 * memory_search tool - Search in memory directory with metadata filtering
 */

import type { Tool, ExecContext, ExecutionInfra } from '../../../foundation/tools/index.js';
import { formatErr } from "../../../foundation/utils/index.js";
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { FileEntry } from '../../../foundation/fs/types.js';
export const MEMORY_SEARCH_TOOL_NAME = 'memory_search' as const;

/**
 * Parse YAML frontmatter (industry standard syntax / per practices.md §DRY reflex 反例落地 / phase 461)
 * 1:1 inline copy from deleted src/foundation/frontmatter/ / 各 caller 自治 / format schema 业务归 caller。
 *
 * Sister implementations（phase 461 ratify「各 caller 自治」、phase 1433 加 cross-ref）：
 * - `src/foundation/skill-system/registry.ts` parseFrontmatter — 简 regex unquote / 有 EOF tolerance（phase 953）
 * - `src/foundation/messaging/codec-inbox.ts` parseFrontmatter — yamlUnquote 富 unquote / 无 EOF tolerance
 *
 * 本实现独有：无（最简 baseline）。
 * 改共享 frame syntax（`---\n` 边界、CRLF 归一、`:` split）需同步 sister；caller 特异保持独立。
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  // Normalize CRLF to LF for consistent parsing
  const normalized = raw.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) return { meta: {}, body: raw };
  const afterOpen = normalized.slice(4);
  const closeIdx = afterOpen.indexOf('\n---\n');
  if (closeIdx < 0) {
    throw new Error('Malformed frontmatter: missing closing ---');
  }

  const meta: Record<string, string> = {};
  for (const line of afterOpen.slice(0, closeIdx).split('\n')) {
    const ci = line.indexOf(':');
    if (ci <= 0) continue;
    const key = line.slice(0, ci).trim();
    const value = line.slice(ci + 1).trim().replace(/^["']|["']$/g, '');
    meta[key] = value;
  }

  // Everything after the closing --- is the body
  return { meta, body: afterOpen.slice(closeIdx + 5).trim() };
}

export const memorySearchTool: Tool = {
  name: MEMORY_SEARCH_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'memory',
  description: 'Full-text search across memory/ files. Supports keyword search, filename regex filtering, and frontmatter metadata filtering. At least one of query or filter is required.',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Full-text search keyword (case-insensitive). Returns matching lines with file path and line number.',
      },
      pattern: {
        type: 'string',
        description: 'Regex to filter by filename, e.g. "2026.*\\.md"',
      },
      filter: {
        type: 'object',
        description: 'Filter by frontmatter fields (AND logic), e.g. {"type":"feedback"}. Can be used alone without query.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default 10)',
      },
      async: {
        type: 'boolean',
        description: 'If true, run in background. Result delivered to inbox when complete. Use for large memory searches or non-blocking queries.',
      },
    },
    // query 和 filter 至少一个必填，用 description 约束而非 required
  },
  readonly: true,
  idempotent: true,
  supportsAsync: true,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    // phase 1459 α-5: memory_search 真依赖仅 `ctx.fs` → `ExecutionInfra` 子接口 sufficient。
    // 编译期标 narrow scope / 测试 fixture 可只 mock `{ fs }` / 不消费 identity/permissions/control/audit dim。
    const infra: ExecutionInfra = ctx;

    const query = ((args.query as string) ?? '').toLowerCase().trim();
    const pattern = (args.pattern as string) ?? '';
    const metaFilter = (args.filter as Record<string, string>) ?? {};
    const maxResults = (args.max_results as number) ?? 10;

    // query 和 filter 至少一个必填
    if (!query && Object.keys(metaFilter).length === 0) {
      return {
        success: false,
        content: '错误: 必须提供 query 或 filter 参数',
      };
    }

    const results: string[] = [];
    let compiled: RegExp | null = null;
    if (pattern) {
      try {
        compiled = new RegExp(pattern);
      } catch (e) {
        return {
          success: false,
          content: `错误: 无效的正则表达式 "${pattern}": ${formatErr(e)}`,
        };
      }
    }

    let entries: FileEntry[];
    try {
      entries = await infra.fs.list('memory/', { recursive: true, includeDirs: false });
    } catch {
      return {
        success: true,
        content: 'memory/ 目录为空，暂无记忆可检索',
      };
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (!entry.path.endsWith('.md')) continue;

      const filename = entry.path.split('/').pop() ?? '';
      if (compiled && !compiled.test(filename)) continue;

      try {
        const text = await infra.fs.read(entry.path);

        // frontmatter 元数据过滤
        if (Object.keys(metaFilter).length > 0) {
          const { meta } = parseFrontmatter(text);
          if (!metaMatches(meta, metaFilter)) continue;
        }

        if (query) {
          // 全文搜索，返回匹配行
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            if (lines[i].toLowerCase().includes(query)) {
              results.push(`[${entry.path}:${i + 1}] ${lines[i].trim()}`);
            }
          }
        } else {
          // 仅 filter 匹配时，返回文件路径
          results.push(`[${entry.path}] (元数据匹配)`);
        }
      } catch {
        // 跳过无法读取的文件
        continue;
      }
    }

    if (results.length === 0) {
      return {
        success: true,
        content: query ? `未找到包含「${query}」的记忆` : '未找到匹配的记忆',
      };
    }

    return {
      success: true,
      content: results.join('\n'),
    };
  },
};

/**
 * Check if frontmatter matches all filter criteria (AND logic)
 */
function metaMatches(fm: Record<string, string>, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([key, value]) =>
    (fm[key] ?? '').toLowerCase().includes(String(value).toLowerCase())
  );
}
