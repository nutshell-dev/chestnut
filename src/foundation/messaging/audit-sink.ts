/**
 * @module L2c.Messaging.AuditSink
 *
 * The only audit capability Messaging consumers need: a structured `write`.
 *
 * phase 1824: Messaging's seven owner files only ever call `audit.write(type,
 * ...cols)`; the full provider-side audit surface (brand, preview/message/
 * summary, artifact/loss lifecycle helpers) is the Audit owner's
 * responsibility and must not leak into cross-module boundaries here.
 * `MessagingAuditSink` is the consumer-declared structural interface — not an
 * alias, not `Pick<>`, no brand — so any real write-only object can enter
 * reader/writer/factory and notification entry points without adaptation.
 *
 * Write contract stays `void` (existing consumption contract): durability and
 * fallback handling remain with the Audit owner's writer.
 */

export interface MessagingAuditSink {
  write(type: string, ...cols: (string | number)[]): void;
}
