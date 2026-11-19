import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(
  new URL(`../../../src/foundation/llm-orchestrator/${file}`, import.meta.url),
  'utf8',
);

const barrelSource = read('index.ts');
const INTERNAL_LEDGER_EXPORTS = [
  'InputMeasurementLedger',
  'InputMeasurementReplayDiagnostic',
  'InputMeasurementReplayState',
  'InputMeasurementRequestState',
  'InputMeasurementRequestStatus',
  'InvocationSelectionLedger',
  'CallAttemptResult',
  'InvocationAttemptReplayState',
  'InvocationReplayState',
  'InvocationSelectionReplayState',
  'ReplayDiagnostic',
  'SelectionState',
] as const;

describe('Phase 2203 Step B: llm-orchestrator ledger internal surface', () => {
  it('barrel 不再导出 ledger class、replay state/diagnostic 及关联内部类型', () => {
    for (const name of INTERNAL_LEDGER_EXPORTS) {
      expect(barrelSource).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('barrel 不通过 wildcard re-export 回流内部 ledger 面', () => {
    expect(barrelSource).not.toMatch(/export\s+(?:type\s+)?\*/);
  });

  it('owner module 保留两个 ledger class', () => {
    expect(read('input-measurement-ledger.ts')).toMatch(/export class InputMeasurementLedger\b/);
    expect(read('invocation-selection-ledger.ts')).toMatch(/export class InvocationSelectionLedger\b/);
  });
});
