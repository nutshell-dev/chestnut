import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import {
  createWatcher as defaultCreateWatcher,
  type Watcher,
  type WatcherFactory,
} from '../../foundation/file-watcher/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import {
  emitPendingIngestFailed,
  emitPendingWatcherFailed,
  emitRecoveryFailed,
} from './audit-emit.js';
import { formatErr } from './_helpers.js';

export interface PendingWatcherDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  pendingDir: string;
  ingest: (filePath: string) => Promise<void>;
  createWatcher?: WatcherFactory;
}

export interface PendingWatcherHandle {
  start: () => Promise<void>;
  close: () => Promise<void>;
}

export function createPendingWatcher(deps: PendingWatcherDeps): PendingWatcherHandle {
  let watcher: Watcher | undefined;
  const watcherFactory = deps.createWatcher ?? defaultCreateWatcher;

  return {
    async start() {
      if (!watcher && typeof deps.fs.resolve === 'function') {
        watcher = watcherFactory(
          deps.fs.resolve(deps.pendingDir),
          (event) => {
            if (event.type !== 'add') return;
            if (!event.path.endsWith('.json')) return;
            deps.ingest(event.path).catch((err) => {
              emitPendingIngestFailed(deps.auditWriter, {
                context: 'watcher_async',
                path: event.path,
                error: formatErr(err),
              });
            });
          },
          {
            stability: 'immediate',
            recursive: false,
            persistent: true,
            onError: (err, context) => {
              const eventType = context === 'callback'
                ? TASK_AUDIT_EVENTS.PENDING_WATCHER_CALLBACK_FAILED
                : TASK_AUDIT_EVENTS.PENDING_WATCHER_FAILED;
              emitPendingWatcherFailed(deps.auditWriter, {
                event: eventType,
                path: deps.pendingDir,
                context,
                reason: err.message,
              });
            },
          },
        );
      }

      try {
        const entries = await deps.fs.list(deps.pendingDir);
        for (const entry of entries) {
          if (entry.name.endsWith('.json')) {
            await deps.ingest(entry.path);
          }
        }
      } catch (err) {
        emitRecoveryFailed(deps.auditWriter, {
          source: 'system',
          context: 'initial_scan_pending_failed',
          error: formatErr(err),
        });
        throw err;
      }
    },

    async close() {
      await watcher?.close();
      watcher = undefined;
    },
  };
}
