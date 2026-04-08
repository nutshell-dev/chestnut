/**
 * Inbox message writer - Unified inbox message creation
 * 
 * Centralizes inbox message format to ensure consistency across all writers.
 * Eliminates duplicate timestamp/UUID/YAML generation code.
 */

import * as fsNative from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { parseFrontmatter } from './frontmatter.js';

export interface InboxMessageOptions {
  /** inbox/pending directory path */
  inboxDir: string;
  /** Message type */
  type: string;
  /** Message source */
  source: string;
  /** Priority level */
  priority: 'critical' | 'high' | 'normal' | 'low';
  /** Message body content */
  body: string;
  /** Target agent id; omit for broadcast */
  to?: string;
  /** ID prefix (default: type) */
  idPrefix?: string;
  /** Filename tag (default: type) */
  filenameTag?: string;
  /** Extra YAML frontmatter fields */
  extraFields?: Record<string, string>;
}

/**
 * Quote a value for safe YAML insertion.
 * Numbers and booleans pass through; strings are double-quoted with escapes.
 */
function yamlQuote(v: string): string {
  // 如果是纯数字或 true/false，直接输出
  if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') return v;
  // 否则双引号包裹，转义 \ " 和换行
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}

/**
 * Write an inbox message with standardized YAML frontmatter format.
 * Creates the inbox directory if it doesn't exist.
 */
export function writeInboxMessage(opts: InboxMessageOptions): void {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const uuid8 = randomUUID().slice(0, 8);
  const idPrefix = opts.idPrefix ?? opts.type;
  const tag = opts.filenameTag ?? opts.type;

  let yaml = `---
id: ${idPrefix}-${now.getTime()}
type: ${opts.type}
source: ${yamlQuote(opts.source)}`;

  if (opts.to) {
    yaml += `\nto: ${yamlQuote(opts.to)}`;
  }

  yaml += `\npriority: ${opts.priority}
timestamp: ${now.toISOString()}`;

  if (opts.extraFields) {
    for (const [k, v] of Object.entries(opts.extraFields)) {
      yaml += `\n${k}: ${yamlQuote(v)}`;
    }
  }

  yaml += `\n---\n\n${opts.body}\n`;

  fsNative.mkdirSync(opts.inboxDir, { recursive: true });
  const finalPath = path.join(opts.inboxDir, `${ts}_${tag}_${uuid8}.md`);
  // 以 . 开头让所有 inbox 扫描器的 !startsWith('.') 过滤器自动忽略临时文件
  const tmpPath = path.join(opts.inboxDir, `.${ts}_${tag}_${uuid8}.tmp`);
  fsNative.writeFileSync(tmpPath, yaml);
  fsNative.renameSync(tmpPath, finalPath);
}

/**
 * 读取 inbox 文件的 frontmatter 元数据。
 * 失败（文件不存在、格式错误等）时返回 null。
 */
export function readInboxFileMeta(filePath: string): Record<string, string> | null {
  try {
    const content = fsNative.readFileSync(filePath, 'utf-8');
    return parseFrontmatter(content).meta;
  } catch {
    return null;
  }
}
