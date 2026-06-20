import type { StreamEvent, StreamLog } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { clipPreview, clipMessage, clipSummary } from '../../foundation/audit/index.js';

export class NoopStreamWriter implements StreamLog {
  write(_event: StreamEvent): boolean {
    return true;
  }
}

export class NoopAuditWriter implements AuditLog {
  readonly __brand = 'AuditLog' as const;
  private seq = 0; // NEW phase 1125 parity (即使 noop 也 increment 防 caller assert seq)

  write(_type: string, ..._cols: (string | number)[]): void {
    this.seq++;
  }

  preview(s: string): string { return clipPreview(s); }
  message(s: string): string { return clipMessage(s); }
  summary(s: string): string { return clipSummary(s); }
}
