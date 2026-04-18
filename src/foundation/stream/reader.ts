/**
 * StreamReader - 订阅 stream.jsonl 新追加事件的 L2 原语
 *
 * 职责：
 * - 监听 stream.jsonl append，解析为新事件后通过 onEvent 回调推送
 * - 维护 byte offset，避免重复推送
 * - 生命周期 start()/stop() 明确绑定 watcher 开关
 *
 * 依赖 FileWatcher 的 'immediate' 稳定性模式（契约 l2_file_watcher.md 候选 β）
 *
 * 不做：
 * - 不 replay 历史
 * - 不解释业务语义（只 JSON parse，不 filter/transform）
 * - 不管归档/轮转
 */

import type { FileSystem } from '../fs/types.js';
import { STREAM_FILE, type StreamEvent } from './types.js';
import type { Audit } from '../audit/index.js';
import { createWatcher, type Watcher } from '../file-watcher/index.js';
import { AUDIT_EVENTS } from '../audit/events.js';

export { STREAM_FILE } from './types.js';

export interface StreamReader {
  /** Start watching and emit new events. Throws if already started. */
  start(): void;
  /** Stop watching. Idempotent. */
  stop(): Promise<void>;
  /** Whether the reader is currently watching. */
  isActive(): boolean;
}

/**
 * Read all historical events from STREAM_FILE.
 * Returns empty array if file does not exist.
 * Parse failures are audit-logged and skipped.
 * Read failures are audit-logged and thrown.
 */
export async function readAll(
  fs: FileSystem,
  audit: Audit,
): Promise<StreamEvent[]> {
  if (!fs.existsSync(STREAM_FILE)) return [];
  let content: string;
  try {
    content = fs.readSync(STREAM_FILE);
  } catch (err) {
    audit.write(
      AUDIT_EVENTS.STREAM_READER_READ_FAILED,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  const events: StreamEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as StreamEvent);
    } catch (err) {
      audit.write(
        AUDIT_EVENTS.STREAM_READER_PARSE_FAILED,
        `line_prefix=${line.slice(0, 80)}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return events;
}

export function createStreamReader(
  fs: FileSystem,
  onEvent: (event: StreamEvent) => void,
  audit: Audit,
): StreamReader {
  let watcher: Watcher | null = null;
  let offset = 0;
  let pending = '';
  let started = false;
  let active = false;

  const readIncrement = (): void => {
    try {
      if (!fs.existsSync(STREAM_FILE)) return;
      const size = fs.statSync(STREAM_FILE).size;
      if (size < offset) {
        // File truncated / replaced — reset
        offset = 0;
        pending = '';
      }
      if (size === offset) return;
      const all = fs.readSync(STREAM_FILE);
      const chunk = all.slice(offset, size);
      offset = size;
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) {
          try {
            const ev = JSON.parse(line) as StreamEvent;
            try {
              onEvent(ev);
            } catch (cbErr) {
              audit.write(
                AUDIT_EVENTS.STREAM_READER_CALLBACK_FAILED,
                `reason=${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
              );
            }
          } catch (err) {
            audit.write(
              AUDIT_EVENTS.STREAM_READER_PARSE_FAILED,
              `line_prefix=${line.slice(0, 80)}`,
              `reason=${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        nl = pending.indexOf('\n');
      }
    } catch (err) {
      audit.write(
        AUDIT_EVENTS.STREAM_READER_READ_FAILED,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    start() {
      if (started) throw new Error('StreamReader already started');
      started = true;
      active = true;
      if (fs.existsSync(STREAM_FILE)) {
        offset = fs.statSync(STREAM_FILE).size;
      } else {
        offset = 0;
      }
      watcher = createWatcher(
        fs,
        STREAM_FILE,
        (ev) => {
          if (ev.type === 'add' || ev.type === 'change') {
            readIncrement();
          } else if (ev.type === 'unlink') {
            audit.write(
              AUDIT_EVENTS.STREAM_READER_UNLINKED,
              `path=${STREAM_FILE}`,
            );
            offset = 0;
            pending = '';
          }
        },
        audit,
        {
          stability: 'immediate',
          onError: (err) => {
            audit.write(
              AUDIT_EVENTS.STREAM_READER_WATCHER_FAILED,
              `reason=${err instanceof Error ? err.message : String(err)}`,
            );
            active = false;
          },
        },
      );
    },
    async stop() {
      if (!started) return;
      started = false;
      active = false;
      if (watcher) {
        const w = watcher;
        watcher = null;
        await w.close();
      }
    },
    isActive() {
      return active;
    },
  };
}
