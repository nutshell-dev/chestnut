/**
 * @module L6.CLI.Claw.Watch
 * phase 5: Subscribe to a one-shot inactivity follow-up notification for a Claw.
 *
 * 用法：
 *   chestnut claw <name> watch [--inactive-after <duration>]
 *     duration: 5m / 30m / 1h (默认 5m / 上限 24h)
 *
 * 语义：
 *   - 注册「<name> 在 <duration> 后若仍 inactive 通知 motion」一次性订阅
 *   - watchdog cron tick 扫订阅、到时间判定 fire-or-skip 都 consume (一次性 / 时间过即失效)
 *   - 不存在永久订阅 / 不需 unwatch
 *
 * 24h 上限：超出 → CLI reject + audit emit (CLAW_WATCH_REJECTED)
 */

import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getChestnutRoot, getClawConfigPath } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { parseDurationMs, DurationParseError } from '../../foundation/duration.js';
import { writeSubscription, MAX_THRESHOLD_MS } from '../../watchdog/subscription-store.js';

const DEFAULT_WATCH_DURATION = '5m';

interface WatchOptions {
  inactiveAfter?: string;   // e.g. '5m' / '30m' / '1h'
}

export async function watchCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  options?: WatchOptions,
  extraDeps?: { audit?: AuditLog },
): Promise<void> {
  const audit = extraDeps?.audit;
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const durationStr = options?.inactiveAfter ?? DEFAULT_WATCH_DURATION;
  let thresholdMs: number;
  try {
    thresholdMs = parseDurationMs(durationStr);
  } catch (err) {
    const reason = err instanceof DurationParseError ? err.message : String(err);
    audit?.write(CLI_AUDIT_EVENTS.CLAW_WATCH_REJECTED, `name=${name}`, `input=${durationStr}`, `reason=parse_failed`);
    throw new CliError(reason);
  }

  if (thresholdMs > MAX_THRESHOLD_MS) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_WATCH_REJECTED, `name=${name}`, `input=${durationStr}`, `reason=exceeds_24h_limit`);
    throw new CliError(`--inactive-after "${durationStr}" exceeds 24h limit`);
  }

  const chestnutRoot = getChestnutRoot();
  const fs = deps.fsFactory(chestnutRoot);
  const subscribed_at = Date.now();
  writeSubscription(fs, name, { subscribed_at, threshold_ms: thresholdMs });

  audit?.write(CLI_AUDIT_EVENTS.CLAW_WATCH, `name=${name}`, `threshold_ms=${thresholdMs}`);
  console.log(`Watching Claw "${name}" for inactivity (notify if still stuck after ${durationStr}).`);
}
