import type { FileSystem } from '../fs/index.js';
import { formatErr } from "../node-utils/index.js";
import type { StreamEvent, StreamLog } from './types.js';
import type { AuditLog } from '../audit/index.js';
import { STREAM_AUDIT_EVENTS } from './audit-events.js';

/**
 * PerResourceStreamWriter — append-only StreamLog at arbitrary path.
 *
 * 与 daemon 单例 StreamWriter 区别：无 open()/close()/archive/prune lifecycle，
 * 即用即写、append-only。caller 负责保证父目录存在（fs.ensureDirSync）。
 *
 * 适用场景：per-task <resultDir>/stream.jsonl、per-subagent stream
 * （caller 自治资源生命周期、无 session 归档语义）。
 *
 * 失败语义：appendSync 异常时 catch + emit STREAM_AUDIT_EVENTS.APPEND_FAILED
 * + 返回 false（mirror daemon StreamWriter.write）。
 */
export class PerResourceStreamWriter implements StreamLog {
  constructor(
    private readonly fs: FileSystem,
    private readonly filePath: string,
    private readonly audit: AuditLog,
  ) {}

  write(event: StreamEvent): void {
    const line = JSON.stringify(event) + '\n';
    try {
      this.fs.appendSync(this.filePath, line);
    } catch (err) {
      this.audit.write(
        STREAM_AUDIT_EVENTS.APPEND_FAILED,
        `path=${this.filePath}`,
        `type=${event.type}`,
        `reason=${formatErr(err)}`,
        `body=${line.trimEnd()}`,
      );
    }
  }
}

export function createPerResourceStreamWriter(
  fs: FileSystem,
  filePath: string,
  audit: AuditLog,
): PerResourceStreamWriter {
  return new PerResourceStreamWriter(fs, filePath, audit);
}
