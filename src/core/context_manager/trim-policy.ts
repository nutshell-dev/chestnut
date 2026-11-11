export type TrimPolicy =
  | { kind: 'proactive'; targetCompleteTokens: number }
  | { kind: 'reactive'; completeFloorTokens: number; completeCeilingTokens: number };
