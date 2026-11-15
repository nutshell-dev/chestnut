/**
 * @module L6.Assembly.ContractCancellationDelivery
 * Bind ContractSystem's committed-cancellation event to Messaging's throwing transport.
 */

import type { ClawNotifier } from '../foundation/messaging/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { contractCancelledNotificationBody } from '../templates/messages/index.js';
import {
  CONTRACT_CANCELLATION_DELIVERY_META_KEY,
  encodeContractCancelledGuidance,
} from '../core/contract/index.js';
import type { ContractCancelledEvent } from '../core/contract/index.js';

export function createContractCancellationDelivery(deps: {
  clawId: string;
  notifyAsync: ClawNotifier['notifyAsync'];
}): (event: ContractCancelledEvent) => Promise<void> {
  return async (event) => {
    await deps.notifyAsync(deps.clawId, {
      type: 'contract_cancelled',
      source: 'system',
      priority: 'high',
      messageId: event.deliveryId,
      // Stable-id reconciliation includes consumed messages; a done cancellation is
      // still delivery evidence and must not be written again after restart.
      includeDoneWithinMs: Infinity,
      body: contractCancelledNotificationBody(deps.clawId, event),
      extraFields: {
        ...encodeContractCancelledGuidance([{
          clawId: makeClawId(deps.clawId),
          contractId: event.contractId,
        }]),
        [CONTRACT_CANCELLATION_DELIVERY_META_KEY]: event.deliveryId,
      },
    });
  };
}
