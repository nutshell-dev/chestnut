/** Public host-supervision capability; no OS adapter is installed by this contract. */
export type {
  HostSupervisor,
  SupervisionAvailability,
  SupervisorDecision,
  SupervisorOwner,
  SupervisorReceipt,
  SupervisorRecovery,
  SupervisorRequest,
  SupervisorResult,
  WatchdogHealth,
} from './types.js';
export { decideWatchdogSupervision, type SupervisionDecisionOptions } from './decision.js';
export { SUPERVISION_AUDIT_EVENTS, SUPERVISION_FILE_ROUTING } from './audit-events.js';
