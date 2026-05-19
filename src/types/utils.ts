import { SUMMARY_MAX_CHARS } from './constants.js';

export function oneLine(s: string): string {
  const content = (s ?? '').trimStart();
  if (content.length <= SUMMARY_MAX_CHARS) return content;
  return content.slice(0, SUMMARY_MAX_CHARS) + '…';
}

export function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function safeNumber(v: unknown, defaultVal?: number): number | undefined {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isNaN(n) ? defaultVal : n;
}
