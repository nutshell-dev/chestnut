/**
 * @module L6.Assembly.ContractCancellationDelivery
 * Bind ContractSystem's committed-cancellation event to Messaging's throwing transport.
 */

import type { ClawNotifier } from '../foundation/messaging/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { contractCancelledNotificationBody } from '../templates/messages/index.js';
import {
  encodeContractCancelledGuidance,
  type ContractNotification,
} from '../core/contract/index.js';

type ContractCancelledEvent = Extract<ContractNotification, { type: 'contract_cancelled' }>;

export function createContractCancellationDelivery(deps: {
  clawId: string;
  notifyAsync: ClawNotifier['notifyAsync'];
}): (event: ContractCancelledEvent) => Promise<void> {
  return async (event) => {
    await deps.notifyAsync(deps.clawId, {
      type: 'contract_cancelled',
      source: 'system',
      priority: 'high',
      messageId: `contract:${event.contractId}:cancelled`,
      body: contractCancelledNotificationBody(deps.clawId, event),
      extraFields: encodeContractCancelledGuidance([{
        clawId: makeClawId(deps.clawId),
        contractId: event.contractId,
      }]),
    });
  };
}
