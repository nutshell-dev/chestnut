import type { StreamEvent, StreamLog } from '../../foundation/stream/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';

export class NoopStreamWriter implements StreamLog {
  write(_event: StreamEvent): void {}
}

export class NoopAuditWriter implements AuditLog {
  write(_type: string, ..._cols: (string | number)[]): void {}
}
