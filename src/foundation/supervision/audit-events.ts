/** Host-supervisor owner events. CLI request/manual-ensure events stay CLI-owned. */
export const SUPERVISION_AUDIT_EVENTS = {
  START: 'supervision_start',
  HEARTBEAT_LOSS: 'supervision_heartbeat_loss',
  TAKEOVER: 'supervision_takeover',
  UNAVAILABLE: 'supervision_unavailable',
} as const;

export const SUPERVISION_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  supervision_start: 'audit',
  supervision_heartbeat_loss: 'audit',
  supervision_takeover: 'audit',
  supervision_unavailable: 'audit',
};
