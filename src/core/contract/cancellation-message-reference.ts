/**
 * @module L4.ContractSystem.CancellationMessageReference
 * Owner-side identification of keyed cancellation messages. Runtime consumes this
 * typed reference instead of learning contract message types or metadata keys.
 */

import type { InboxMessage } from '../../foundation/messaging/index.js';
import {
  CONTRACT_CANCELLATION_DELIVERY_META_KEY,
  cancellationDeliveryId,
} from './cancellation-delivery-store.js';
import { makeContractId } from './types.js';
import { decodeContractCancelledGuidance } from './contract-cancelled-guidance.js';

export type ContractCancellationMessageReference =
  | {
      readonly kind: 'keyed';
      readonly contractId: ReturnType<typeof makeContractId>;
      readonly deliveryId: string;
    }
  | { readonly kind: 'legacy_unkeyed' | 'identity_conflict' };

export function readContractCancellationMessageReference(
  message: Pick<InboxMessage, 'id' | 'type' | 'from' | 'metadata' | 'extraMeta'>,
): ContractCancellationMessageReference | undefined {
  if (message.type !== 'contract_cancelled' || message.from !== 'system') return undefined;
  const deliveryId = message.metadata?.[CONTRACT_CANCELLATION_DELIVERY_META_KEY]
    ?? message.extraMeta?.[CONTRACT_CANCELLATION_DELIVERY_META_KEY];
  if (!deliveryId) return { kind: 'legacy_unkeyed' };
  try {
    const metadata = message.metadata ?? message.extraMeta ?? {};
    const guidance = decodeContractCancelledGuidance({
      type: message.type,
      from: message.from,
      // Generic metadata (for example contract_id) is not part of the guidance
      // dialect; passing it through would be misclassified as a legacy key.
      meta: Object.fromEntries(Object.entries(metadata).filter(([key]) =>
        key === 'guidance_schema_version' || key === 'cancelled_contract_refs')),
    });
    const contractId = guidance.contractRefs.length === 1
      ? guidance.contractRefs[0]?.contractId
      : undefined;
    if (
      !contractId || deliveryId !== message.id ||
      deliveryId !== cancellationDeliveryId(contractId)
    ) return { kind: 'identity_conflict' };
    return { kind: 'keyed', contractId, deliveryId };
  } catch {
    // silent: malformed or ambiguous guidance becomes identity_conflict evidence
    // Malformed/ambiguous guidance cannot be joined to a durable intent.
    return { kind: 'identity_conflict' };
  }
}
