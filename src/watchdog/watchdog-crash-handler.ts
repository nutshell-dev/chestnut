/**
 * @module L6.Watchdog.CrashHandler
 * @layer L6 进程边界（Watchdog 守护进程）
 *
 * Watchdog 进程级 crash handler：
 * - 可捕获崩溃（uncaughtException / unhandledRejection）在退出前写 `crashed`
 *   terminal 与 `watchdog_crash` audit；任一阶段未确认都保留 raw fallback；
 * - SIGKILL/断电等不可捕获终止由下次 CLI 触发 recovery 时根据 stale active
 *   补记 `unclean` terminal。
 *
 * 本模块只注册 handler，不启动 loop，便于 entry 与测试分别使用。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { getAuditWriter, getChestnutFs } from './watchdog-context.js';
import { writeWatchdogRawFallback } from './watchdog-log.js';
import {
  inspectActive,
  recordGenerationTerminal,
  type RecordTerminalResult,
} from './watchdog-ownership.js';
import { writeWatchdogCrash } from './watchdog-state.js';

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

export interface WatchdogCrashIdentity {
  attemptId: string;
  ownerToken: string;
  pid: number;
}

export type WatchdogCrashTerminalResult = RecordTerminalResult & {
  /** 读取 active 时观察到的身份；active 缺失或读取失败时为 null。 */
  identity: WatchdogCrashIdentity | null;
};

/** 读取并 generation-guard 当前 active；所有失败以 typed result 交付，不静默。 */
export function recordCrashTerminal(
  fsFactory: (baseDir: string) => FileSystem,
  reason: unknown,
): WatchdogCrashTerminalResult {
  let identity: WatchdogCrashIdentity | null = null;
  try {
    const fs = getChestnutFs(fsFactory);
    const active = inspectActive(fs);
    if (active.status === 'none') return { kind: 'no_active', identity };
    if (active.status === 'malformed') {
      return { kind: 'malformed', identity, cause: active.cause };
    }
    identity = {
      attemptId: active.owner.attempt_id,
      ownerToken: active.owner.owner_token,
      pid: active.owner.pid,
    };
    const result = recordGenerationTerminal(
      fs,
      identity,
      {
        kind: 'crashed',
        reason: errMsg(reason),
        recorded_at: new Date().toISOString(),
      },
    );
    return { ...result, identity };
  } catch (cause) {
    return { kind: 'failed', identity, cause: formatErr(cause) };
  }
}

function identityCols(identity: WatchdogCrashIdentity | null): string[] {
  return [
    `attempt=${identity?.attemptId ?? 'unknown'}`,
    `owner_token=${identity?.ownerToken ?? 'unknown'}`,
    `pid=${identity?.pid ?? 'unknown'}`,
  ];
}

function writeCrashFallback(
  fsFactory: (baseDir: string) => FileSystem,
  stage: string,
  error: unknown,
  terminalResult: WatchdogCrashTerminalResult,
  reason: unknown,
): void {
  const line = `[watchdog-crash] stage=${stage} terminal=${terminalResult.kind} ` +
    `${identityCols(terminalResult.identity).join(' ')} ` +
    `error=${formatErr(error)} crash=${errMsg(reason)}\n`;
  writeWatchdogRawFallback(fsFactory, line);
}

function handleWatchdogCrash(
  fsFactory: (baseDir: string) => FileSystem,
  label: 'Uncaught exception' | 'Unhandled rejection',
  reason: unknown,
): void {
  const terminalResult = recordCrashTerminal(fsFactory, reason);
  if (terminalResult.kind !== 'recorded' && terminalResult.kind !== 'already_recorded') {
    writeCrashFallback(
      fsFactory,
      `terminal_${terminalResult.kind}`,
      'cause' in terminalResult
        ? terminalResult.cause
        : `crash terminal not confirmed: ${terminalResult.kind}`,
      terminalResult,
      reason,
    );
  }

  const auditResult = writeWatchdogCrash(
    reason instanceof Error ? reason : new Error(errMsg(reason)),
    `terminal=${terminalResult.kind}`,
    ...identityCols(terminalResult.identity),
  );
  if (auditResult.kind !== 'recorded') {
    writeCrashFallback(
      fsFactory,
      auditResult.kind === 'failed' ? 'audit_failed' : 'audit_unavailable',
      auditResult.kind === 'failed' ? auditResult.cause : 'audit writer unavailable',
      terminalResult,
      reason,
    );
  }

  console.error(`[watchdog] ${label}:`, reason);
  try {
    getAuditWriter()?.dispose?.();
  } catch (disposeError) {
    console.error('[watchdog] audit dispose failed:', disposeError);
    writeCrashFallback(fsFactory, 'dispose_failed', disposeError, terminalResult, reason);
  }
  process.exit(1);
}

export function registerWatchdogCrashHandlers(
  fsFactory: (baseDir: string) => FileSystem,
): void {
  process.on('uncaughtException', (err) => {
    handleWatchdogCrash(fsFactory, 'Uncaught exception', err);
  });

  process.on('unhandledRejection', (reason) => {
    handleWatchdogCrash(fsFactory, 'Unhandled rejection', reason);
  });
}
