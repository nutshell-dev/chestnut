/**
 * @module L4.ContractSystem.CancellationDelivery
 * Committed cancellation delivery facts, independent of the optional observer sink.
 */

import { formatErr } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { emitContractNotifyFailed } from './audit-emit.js';
import type { CancellationTransitionOutcome } from './lifecycle.js';
import type { ContractNotification, ContractNotificationSink } from './notification.js';

export type ContractCancelledEvent = Extract<ContractNotification, { type: 'contract_cancelled' }>;

export type CancellationDeliveryResult =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'failed'; readonly cause: unknown }
  | { readonly kind: 'not_attempted' };

export type ContractCancelOutcome = CancellationTransitionOutcome & {
  readonly cancellationDelivery: CancellationDeliveryResult;
};

export type CancellationDelivery = (event: ContractCancelledEvent) => Promise<void>;

/**
 * `delivered` means only that the injected throwing transport returned normally.
 * It is not a durable receipt, consumption acknowledgement, or execution-stop fact.
 */
export async function attemptCancellationDelivery(
  event: ContractCancelledEvent,
  deliverCancellation: CancellationDelivery,
  audit: AuditLog,
): Promise<CancellationDeliveryResult> {
  try {
    await deliverCancellation(event);
    return { kind: 'delivered' };
  } catch (deliveryError) {
    let cause = deliveryError;
    try {
      emitContractNotifyFailed(audit, {
        notifyType: event.type,
        error: formatErr(deliveryError),
      });
    } catch (auditError) {
      cause = new AggregateError(
        [deliveryError, auditError],
        `Cancellation delivery failed: ${formatErr(deliveryError)}; failure audit: ${formatErr(auditError)}`,
      );
      try {
        process.stderr.write(
          `[contract] cancellation delivery failure audit error: ${JSON.stringify({
            deliveryError: formatErr(deliveryError),
            auditError: formatErr(auditError),
          })}\n`,
        );
      } catch (diagnosticError) {
        // The caller receives every original cause even when the fallback cannot write.
        cause = new AggregateError(
          [deliveryError, auditError, diagnosticError],
          `Cancellation delivery failed: ${formatErr(deliveryError)}; failure audit: ${formatErr(auditError)}; diagnostic output: ${formatErr(diagnosticError)}`,
        );
      }
    }
    return { kind: 'failed', cause };
  }
}

/** Observation remains best-effort and must never trigger a second business delivery. */
export function notifyCancellationObserver(
  event: ContractCancelledEvent,
  onNotify: ContractNotificationSink | undefined,
  audit: AuditLog,
): void {
  try {
    onNotify?.(event);
  } catch (observerError) {
    try {
      emitContractNotifyFailed(audit, {
        notifyType: event.type,
        error: formatErr(observerError),
      });
    } catch (auditError) {
      process.stderr.write(
        `[contract] cancellation observer failure audit error: ${JSON.stringify({
          observerError: formatErr(observerError),
          auditError: formatErr(auditError),
        })}\n`,
      );
    }
  }
}
