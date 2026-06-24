/**
 * memory_search tool - Search in memory directory with metadata filtering
 */

import type { Tool, ExecContext, ExecutionInfra } from '../../../foundation/tools/index.js';
import { formatErr } from "../../../foundation/node-utils/index.js";
import { parseFrontmatterFrame } from "../../../foundation/messaging/frontmatter-frame.js";
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { FileEntry } from '../../../foundation/fs/index.js';
import { isFileNotFound } from '../../../foundation/fs/index.js';
import { MEMORY_DIR } from '../memory-paths.js';
export const MEMORY_SEARCH_TOOL_NAME = 'memory_search' as const;

/**
 * Default cap on memory search results returned to agent.
 * Derivation: 10 result ≈ agent 单次 search 可处理的 hit 数（避免 LLM context 灌爆）/
 * 配合 RECENT_EXEC_N_DEFAULT (50) 给 footprint sample 留位 / 平衡 recall vs precision.
 */
const SEARCH_MAX_RESULTS_DEFAULT = 10;



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
    const maxResults = (args.max_results as number) ?? SEARCH_MAX_RESULTS_DEFAULT;

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
      entries = await infra.fs.list(`${MEMORY_DIR}/`, { recursive: true, includeDirs: false });
    } catch (err) {
      // phase 517 B6: 区分 ENOENT（真空目录）vs 其他 IO/权限错（应暴露给 agent）
      if (isFileNotFound(err)) {
        return {
          success: true,
          content: `${MEMORY_DIR}/ 目录为空，暂无记忆可检索`,
        };
      }
      return {
        success: false,
        content: `${MEMORY_DIR}/ 检索失败: ${formatErr(err)}`,
      };
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (!entry.path.endsWith('.md')) continue;

      const filename = entry.path.split('/').pop() ?? '';
      if (compiled && !compiled.test(filename)) continue;

      try {
        const text = await infra.fs.read(entry.path);

        // frontmatter 元数据过滤 (phase 62: frame syntax 共享 helper + caller-side unquote 自治)
        if (Object.keys(metaFilter).length > 0) {
          const { meta: rawMeta } = parseFrontmatterFrame(text);
          const meta: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawMeta)) {
            meta[k] = v.replace(/^["']|["']$/g, '');
          }
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
