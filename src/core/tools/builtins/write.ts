/**
 * write tool - Write or append to file
 * 
 * Features (MVP aligned):
 * - Automatic version backup to .versions/ (keep last 10)
 * - Size limits: MEMORY.md 50/200KB, memory/ 100/500KB, clawspace/ 5MB/20MB
 * - Soft limit warns, hard limit rejects
 */

import * as path from 'path';
import type { Tool, ToolResult, ExecContext } from '../executor.js';
import { WRITE_SIZE_LIMITS, WRITE_VERSION_RETENTION } from '../../../constants.js';

function getSizeLimits(filePath: string): [number, number] {
  for (const [prefix, limits] of Object.entries(WRITE_SIZE_LIMITS)) {
    if (prefix === 'default') continue;
    if (filePath === prefix || filePath.startsWith(prefix)) {
      return limits;
    }
  }
  return WRITE_SIZE_LIMITS['default'];
}

async function backupVersion(fs: ExecContext['fs'], filePath: string): Promise<string | null> {
  try {
    // Check if file exists
    const exists = await fs.exists(filePath);
    if (!exists) return null;

    // Read existing content
    const content = await fs.read(filePath);
    
    // Create .versions directory
    const dir = path.dirname(filePath);
    const versionsDir = dir === '.' ? '.versions' : path.join(dir, '.versions');
    await fs.ensureDir(versionsDir);
    
    // Generate version filename: {original}.{timestamp}.bak
    const basename = path.basename(filePath);
    const timestamp = Date.now();
    const versionPath = path.join(versionsDir, `${basename}.${timestamp}.bak`);
    
    await fs.writeAtomic(versionPath, content);
    
    // Cleanup old versions (keep last 10)
    try {
      const entries = await fs.list(versionsDir, { includeDirs: false });
      const versionFiles = entries
        .filter(e => e.name.startsWith(`${basename}.`) && e.name.endsWith('.bak'))
        .sort((a, b) => {
          // Extract timestamps and sort numerically (not lexically)
          const getTs = (name: string) => {
            const match = name.match(/\.(\d+)\.bak$/);
            return match ? parseInt(match[1], 10) : 0;
          };
          return getTs(b.name) - getTs(a.name); // Newest first
        });
      
      for (let i = WRITE_VERSION_RETENTION; i < versionFiles.length; i++) {
        await fs.delete(versionFiles[i].path);
      }
    } catch {
      // Ignore cleanup errors
    }
  } catch (err) {
    return `Backup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

import { WRITE_TOOL_NAME } from '../tool-names.js';
export { WRITE_TOOL_NAME };

export const writeTool: Tool = {
  name: WRITE_TOOL_NAME,
  description: 'Write content to a file. Use append=true to append instead of overwrite. Auto-backups to .versions/ (keep 10). Size limits: MEMORY.md 50/200KB, memory/ 100/500KB, clawspace/ 5MB/20MB. WARNING: single LLM output is limited to ~4096 tokens (~3000 chars). For long files, split into multiple write calls: first call without append, subsequent calls with append=true.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
      append: {
        type: 'boolean',
        description: 'If true, append to file instead of overwriting',
      },
    },
    required: ['path', 'content'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const content = args.content as string;
    const append = args.append === true;

    // Size limits (MVP aligned)
    const [softLimit, hardLimit] = getSizeLimits(filePath);
    
    if (content.length > hardLimit) {
      return {
        success: false,
        content: `Error: Content exceeds hard limit (${hardLimit / 1024}KB) for ${filePath}`,
      };
    }

    // Check total size for append mode
    if (append) {
      let existingSize = 0;
      try {
        const s = await ctx.fs.stat(filePath);
        existingSize = s.size;
      } catch {
        // File doesn't exist yet; existingSize stays 0
      }
      if (existingSize + content.length > hardLimit) {
        return {
          success: false,
          content: `Error: Appended content would exceed hard limit (${hardLimit / 1024}KB) for ${filePath} (existing: ${Math.round(existingSize / 1024)}KB + new: ${Math.round(content.length / 1024)}KB)`,
        };
      }
    }

    const warnings: string[] = [];
    if (content.length > softLimit) {
      warnings.push(`Warning: Content exceeds soft limit (${softLimit / 1024}KB)`);
    }

    try {
      // Create backup before overwrite (MVP aligned)
      if (!append) {
        const backupWarning = await backupVersion(ctx.fs, filePath);
        if (backupWarning) warnings.push(backupWarning);
      }

      if (append) {
        await ctx.fs.append(filePath, content);
      } else {
        await ctx.fs.writeAtomic(filePath, content);
      }

      const warningMsg = warnings.length > 0 ? `\n${warnings.join('\n')}` : '';
      return {
        success: true,
        content: `Written: ${filePath} (${content.length} chars)${warningMsg}`,
      };
    } catch (error) {
      return {
        success: false,
        content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
