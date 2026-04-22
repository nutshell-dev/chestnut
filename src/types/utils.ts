import { SUMMARY_MAX_CHARS } from '../constants.js';

export function oneLine(s: string): string {
  const content = (s ?? '').trimStart();
  if (content.length <= SUMMARY_MAX_CHARS) return content;
  return content.slice(0, SUMMARY_MAX_CHARS) + '…';
}
