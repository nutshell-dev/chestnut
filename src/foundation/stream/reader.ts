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
import type { StreamEvent } from './types.js';
import type { AuditLog } from '../audit/index.js';
import { createWatcher, type Watcher } from '../file-watcher/index.js';
import { STREAM_AUDIT_EVENTS } from './audit-events.js';
import { StringDecoder } from 'node:string_decoder';

/** chokidar 静默停火 fallback poll 间隔（A.6 / phase352） */
const FALLBACK_POLL_MS = 500;

/** 连续 parse_failed 达到此值触发 STREAM_READER_CORRUPT（trigger=consecutive_fail）。 */
const CONSECUTIVE_PARSE_FAIL_LIMIT = 5;

/** recentOutcomes 环形窗口大小；窗口满后按占比判定 ratio_high。 */
const RECENT_WINDOW = 10;

/** 近 RECENT_WINDOW 次 parse 的失败占比阈值（> 则触发 trigger=ratio_high）。 */
const RECENT_FAIL_RATIO_THRESHOLD = 0.5;

export interface StreamReader {
  /** Start watching and emit new events. Throws if already started. */
  start(): void;
  /** Stop watching. Idempotent. */
  stop(): Promise<void>;
  /** Whether the reader is currently watching. */
  isActive(): boolean;
}

/**
 * Read all historical events from streamPath.
 * NOTE: reads entire file into memory; suitable for < few MB streams.
 * Returns empty array if file does not exist.
 * Parse failures are audit-logged and skipped.
 * Read failures are audit-logged and thrown.
 */
export async function readAll(
  fs: FileSystem,
  streamPath: string,
  audit: AuditLog,
): Promise<StreamEvent[]> {
  if (!fs.existsSync(streamPath)) return [];
  let content: string;
  try {
    content = fs.readSync(streamPath);
  } catch (err) {
    audit.write(
      STREAM_AUDIT_EVENTS.READER_READ_FAILED,
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
        STREAM_AUDIT_EVENTS.READER_PARSE_FAILED,
        `line_prefix=${line.slice(0, 80)}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return events;
}

export function createStreamReader(
  fs: FileSystem,
  streamPath: string,
  onEvent: (event: StreamEvent) => void,
  audit: AuditLog,
  options?: { persistent?: boolean },
): StreamReader {
  let watcher: Watcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let offset = 0;
  let pending = '';
  let decoder = new StringDecoder('utf-8');
  let started = false;
  let active = false;
  let consecutiveParseFails = 0;
  const recentOutcomes: boolean[] = [];

  const recordOutcome = (ok: boolean): void => {
    recentOutcomes.push(ok);
    if (recentOutcomes.length > RECENT_WINDOW) {
      recentOutcomes.shift();
    }
  };

  const triggerCorrupt = (trigger: 'consecutive_fail' | 'ratio_high'): void => {
    const recentFail = recentOutcomes.filter((ok) => !ok).length;
    audit.write(
      STREAM_AUDIT_EVENTS.READER_CORRUPT,
      `path=${streamPath}`,
      `consecutive=${consecutiveParseFails}`,
      `trigger=${trigger}`,
      `recent_total=${recentOutcomes.length}`,
      `recent_fail=${recentFail}`,
    );
    active = false;
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    void watcher?.close();
    watcher = null;
  };

  const checkEscalation = (): boolean => {
    if (consecutiveParseFails >= CONSECUTIVE_PARSE_FAIL_LIMIT) {
      triggerCorrupt('consecutive_fail');
      return true;
    }
    if (recentOutcomes.length >= RECENT_WINDOW) {
      const failCount = recentOutcomes.filter((ok) => !ok).length;
      if (failCount / recentOutcomes.length > RECENT_FAIL_RATIO_THRESHOLD) {
        triggerCorrupt('ratio_high');
        return true;
      }
    }
    return false;
  };

  const readIncrement = (): void => {
    if (!active) return;
    try {
      if (!fs.existsSync(streamPath)) return;
      const size = fs.statSync(streamPath).size;
      if (size < offset) {
        // File truncated / replaced — reset
        offset = 0;
        pending = '';
        decoder = new StringDecoder('utf-8');
      }
      if (size === offset) return;

      // 字节安全范围读 + StringDecoder 缓冲跨 chunk 的多字节字符边界
      const buf = fs.readBytesSync(streamPath, offset, size);
      offset += buf.length;
      pending += decoder.write(buf);

      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) {
          try {
            const ev = JSON.parse(line) as StreamEvent;
            consecutiveParseFails = 0;
            recordOutcome(true);
            try {
              onEvent(ev);
            } catch (cbErr) {
              audit.write(
                STREAM_AUDIT_EVENTS.READER_CALLBACK_FAILED,
                `reason=${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
              );
            }
          } catch (err) {
            consecutiveParseFails++;
            recordOutcome(false);
            audit.write(
              STREAM_AUDIT_EVENTS.READER_PARSE_FAILED,
              `line_prefix=${line.slice(0, 80)}`,
              `reason=${err instanceof Error ? err.message : String(err)}`,
            );
            if (checkEscalation()) {
              return;
            }
          }
        }
        nl = pending.indexOf('\n');
      }
    } catch (err) {
      audit.write(
        STREAM_AUDIT_EVENTS.READER_READ_FAILED,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    start() {
      if (started) throw new Error('StreamReader already started');
      started = true;
      active = true;
      if (fs.existsSync(streamPath)) {
        offset = fs.statSync(streamPath).size;
      } else {
        offset = 0;
        audit.write(
          STREAM_AUDIT_EVENTS.READER_FILE_MISSING,
          `path=${streamPath}`,
          'reason=start_existsSync_false',
        );
      }
      fallbackTimer = setInterval(() => {
        if (active) readIncrement();
      }, FALLBACK_POLL_MS);

      watcher = createWatcher(
        fs.resolve(streamPath),
        (ev) => {
          if (ev.type === 'add' || ev.type === 'change') {
            readIncrement();
          } else if (ev.type === 'unlink') {
            audit.write(
              STREAM_AUDIT_EVENTS.READER_UNLINKED,
              `path=${streamPath}`,
            );
            offset = 0;
            pending = '';
          }
        },
        {
          stability: 'immediate',
          persistent: options?.persistent,
          onError: (err, context) => {
            if (context === 'callback') {
              audit.write(
                STREAM_AUDIT_EVENTS.READER_WATCHER_CALLBACK_FAILED,
                `path=${streamPath}`,
                `reason=${err.message}`,
              );
              return;
            }
            audit.write(
              STREAM_AUDIT_EVENTS.READER_WATCHER_FAILED,
              `path=${streamPath}`,
              `context=${context}`,
              `reason=${err.message}`,
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
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
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
