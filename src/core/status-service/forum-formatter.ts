/**
 * Forum-level status formatter — pure ForumStatusView → text lines.
 *
 * Phase 1478 — output format locked by §0 D1-D12:
 *   - top: `clawforum status` + timestamp
 *   - System: watchdog / motion (motion includes inbox)
 *   - orphan warnings inline (only when hit)
 *   - Active claws (N / total) section, each claw 3 lines
 *
 * Format is intentionally close to mockup ratified in conversation 2026-05-30.
 */

import type { ForumStatusView, SystemComponentView, ActiveClawView } from './forum-aggregators.js';
import { MOTION_CLAW_ID } from '../../constants.js';

const NAME_PAD = 18;
const SYS_NAME_PAD = 10;

export function formatForumStatusView(view: ForumStatusView): string[] {
  const lines: string[] = [];

  lines.push(`clawforum status${pad('', 36)}${view.timestamp}`);
  lines.push('');

  // ── System ──
  lines.push('System');
  lines.push(`  ${formatSystemRow('watchdog', view.system.watchdog)}`);
  lines.push(`  ${formatSystemRow(MOTION_CLAW_ID, view.system.motion)}`);
  for (const pid of view.orphans.watchdog) {
    lines.push(`  ⚠ orphan watchdog: PID ${pid}`);
  }
  for (const pid of view.orphans.daemon) {
    lines.push(`  ⚠ orphan daemon:   PID ${pid}`);
  }
  lines.push('');

  // ── Active claws ──
  const n = view.activeClaws.length;
  lines.push(`Active claws (${n} / ${view.totalClawCount})`);
  for (const claw of view.activeClaws) {
    lines.push(`  ${formatActiveClawHeader(claw)}`);
    lines.push(`    last activity   ${humanizeAgo(claw.lastActivityAgoMs)}`);
    lines.push(`    inbox           ${claw.inboxUnread} unread`);
  }

  return lines;
}

function formatSystemRow(name: string, c: SystemComponentView): string {
  const namePad = pad(name, SYS_NAME_PAD);
  if (!c.alive) {
    return `${namePad}stopped${c.reason && c.reason !== 'stopped' ? `   (${c.reason})` : ''}`;
  }
  const pidStr = c.pid !== undefined ? `   PID ${c.pid}` : '';
  const upStr = `   uptime ${humanizeUptime(c.uptimeMs)}`;
  const inboxStr = c.inboxUnread !== undefined ? `   inbox: ${c.inboxUnread} unread` : '';
  return `${namePad}running${pidStr}${upStr}${inboxStr}`;
}

function formatActiveClawHeader(claw: ActiveClawView): string {
  const namePad = pad(claw.name, NAME_PAD);
  return `${namePad}running   PID ${claw.pid}   uptime ${humanizeUptime(claw.uptimeMs)}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

export function humanizeUptime(ms: number | undefined): string {
  if (ms === undefined) return 'unknown';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function humanizeAgo(ms: number | undefined): string {
  if (ms === undefined) return 'unknown';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m ago`;
}
