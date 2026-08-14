/**
 * @module L6.CLI.Claw.Wakeup
 *
 * phase 1386: `chestnut claw <id> wakeup` —— 定时消息（wakeup）CLI 入口。
 *
 * 形态：
 * - schedule: `wakeup (--in <duration> | --at <iso>) "<message>"`
 * - list:     `wakeup list`
 * - cancel:   `wakeup cancel <wakeup-id>`
 *
 * 安排持久化在 Messaging wakeup store（`<clawDir>/wakeups/<id>.json`），到期由
 * motion cron `wakeup-delivery` job 投递到 claw inbox。本命令只写 store / list / cancel。
 *
 * 时长 `--in` 支持 `30s / 5m / 2h / 1d` 及复合 `1h30m`（phase 1383 删过 claw watch
 * duration parser、本命令内最小实现，无通用 parser 可复用）。
 */

import * as path from 'path';

import { getChestnutRoot, getClawConfigPath, getRelativeClawDir, routeNotifyClaw, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  scheduleWakeup,
  cancelWakeup,
  listWakeups,
  WakeupNotFoundError,
  type WakeupRecord,
} from '../../foundation/messaging/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

/** 解析 `30s / 5m / 2h / 1d / 1h30m` 形态时长 → 毫秒。非法输入 throw Error。 */
export function parseDurationMs(input: string): number {
  const matches = input.matchAll(/(\d+)\s*([smhd])/g);
  let total = 0;
  let consumed = 0;
  for (const m of matches) {
    const value = parseInt(m[1], 10);
    const unit = m[2] as 's' | 'm' | 'h' | 'd';
    const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    total += value * multiplier;
    consumed += m[0].length;
  }
  if (total <= 0 || consumed !== input.replace(/\s+/g, '').length) {
    throw new CliError(
      `Invalid --in duration '${input}'. Expected forms like 30s, 5m, 2h, 1d, or 1h30m`,
    );
  }
  return total;
}

function formatRelativeTime(deliverAt: string, now: Date): string {
  const deltaMs = Date.parse(deliverAt) - now.getTime();
  if (deltaMs <= 0) return 'due now';
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export async function wakeupCommand(
  deps: ClawCommandDeps,
  name: string,
  args: {
    subcommand: 'schedule';
    message: string;
    inDuration?: string;
    atIso?: string;
  } | {
    subcommand: 'list';
    json: boolean;
  } | {
    subcommand: 'cancel';
    wakeupId: string;
  },
): Promise<void> {
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const baseDir = getChestnutRoot();
  const clawDir = path.join(baseDir, getRelativeClawDir(name));
  const fileSystem = deps.fsFactory(baseDir);
  const audit = createSystemAudit(fileSystem, clawDir);

  if (args.subcommand === 'list') {
    const records = listWakeups(fileSystem, clawDir);
    if (args.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log(`No wakeups scheduled for "${name}"`);
      return;
    }
    const now = new Date();
    for (const r of records) {
      console.log(`${r.id}  ${r.deliverAt}  (${formatRelativeTime(r.deliverAt, now)})  ${r.message}`);
    }
    return;
  }

  if (args.subcommand === 'cancel') {
    try {
      cancelWakeup(fileSystem, clawDir, name, args.wakeupId, audit);
    } catch (e) {
      if (e instanceof WakeupNotFoundError) {
        throw new CliError(`Wakeup "${args.wakeupId}" not found for claw "${name}"`);
      }
      throw e;
    }
    console.log(`Wakeup "${args.wakeupId}" cancelled`);
    return;
  }

  // schedule
  const message = args.message;
  if (message.trim().length === 0) {
    throw new CliError('Wakeup message must not be empty');
  }

  let deliverAt: Date;
  if (args.inDuration !== undefined) {
    deliverAt = new Date(Date.now() + parseDurationMs(args.inDuration));
  } else if (args.atIso !== undefined) {
    const ms = Date.parse(args.atIso);
    if (Number.isNaN(ms)) {
      throw new CliError(`Invalid --at ISO time '${args.atIso}'`);
    }
    deliverAt = new Date(ms);
  } else {
    throw new CliError('Schedule requires either --in <duration> or --at <iso>');
  }

  const result = scheduleWakeup(fileSystem, clawDir, name, deliverAt.toISOString(), message, audit);
  if (result.immediate) {
    // deliverAt 已过 → 立即投递（与 wakeup-delivery job 同 message 形态）——不落 store、
    // 必须由本命令直接投递，否则消息静默丢失（DP1）。
    routeNotifyClaw(fileSystem, baseDir, MOTION_CLAW_ID, name, {
      type: 'wakeup',
      source: MOTION_CLAW_ID,
      priority: 'normal',
      body: message,
      metadata: { wakeup_id: result.record.id, scheduled_for: result.record.deliverAt },
    }, audit);
    console.log(
      `Wakeup ${result.record.id} delivered now (deliverAt ${result.record.deliverAt} was in the past)`,
    );
  } else {
    console.log(`Wakeup ${result.record.id} scheduled for ${result.record.deliverAt}`);
  }
}

/** Test-only helper: render a record list as the CLI does (kept for snapshot tests). */
export function __formatWakeupLine(r: WakeupRecord, now: Date): string {
  return `${r.id}  ${r.deliverAt}  (${formatRelativeTime(r.deliverAt, now)})  ${r.message}`;
}
