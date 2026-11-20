/** Neutral repair-action contract shared by the editor and connection-check adapter. */
export type LLMRepairAction = 'retry' | 'edit-key' | 'edit-model' | 'edit-provider' | 'cancel';

export const LLM_REPAIR_ACTIONS: readonly LLMRepairAction[] = [
  'retry',
  'edit-key',
  'edit-model',
  'edit-provider',
  'cancel',
];
