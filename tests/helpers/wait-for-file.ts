import { readFile, access, mkdir, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { WAIT_FOR_DEFAULT_BUDGET_MS } from './test-timeouts.js';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';

/**
 * Wait for a file to match a regex predicate.
 * phase 367: event-driven file-watcher 替原 setTimeout poll.
 *
 * 流程:
 *   1. initial readFile + regex check (avoid race when file 已存在)
 *   2. createWatcher on path; 'add'/'change' → retry readFile + regex
 *   3. match → resolve
 *   4. timeout safety net → reject
 */
export async function waitForCompleteFile(
  filePath: string,
  regex: RegExp,
  timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS,
): Promise<string> {
  // initial check
  try {
    const content = await readFile(filePath, 'utf-8');
    if (regex.test(content)) return content;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  return new Promise<string>((resolve, reject) => {
    let resolved = false;
    const onSettle = (val: string | Error): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      watcher.close().catch(() => { /* silent: cleanup */ });
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    const tryRead = async (): Promise<void> => {
      try {
        const content = await readFile(filePath, 'utf-8');
        if (regex.test(content)) onSettle(content);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onSettle(e as Error);
      }
    };
    const watcher = createWatcher(
      filePath,
      (event) => {
        if (event.type === 'add' || event.type === 'change') void tryRead();
      },
      { persistent: false, stability: 'immediate' },
    );
    const timer = setTimeout(
      () => onSettle(new Error(`waitForCompleteFile timeout: ${filePath} did not match ${regex} in ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

/**
 * Wait for a path (file or dir) to exist.
 * phase 367: event-driven file-watcher on parent dir 替 fs.access polling.
 *
 * 实施约束: 父 dir 必须先存在（chokidar 监不存在 path 不可靠 / phase 743 CI inotify 教训）。
 * caller 传入的 targetPath 的父 dir 如不存在、自动 mkdir(recursive) 创建（idempotent）.
 */
export async function waitForPathExists(
  targetPath: string,
  timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS,
): Promise<void> {
  // initial check
  try {
    await access(targetPath);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const parentDir = path.dirname(targetPath);
  const targetName = path.basename(targetPath);

  // 父 dir 不存在则创（idempotent）— 让 chokidar 监已存 path
  await mkdir(parentDir, { recursive: true });

  // 再 check 一次（target 可能在 mkdir 期间被创建）
  try {
    await access(targetPath);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const onSettle = (err?: Error): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      watcher.close().catch(() => { /* silent: cleanup */ });
      if (err) reject(err); else resolve();
    };
    const tryAccess = async (): Promise<void> => {
      try {
        await access(targetPath);
        onSettle();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onSettle(e as Error);
      }
    };
    const watcher = createWatcher(
      parentDir,
      (event) => {
        // 'add' (file) / 'addDir' (sub-dir created) / 'change' 都触发 retry
        if (event.type === 'add' || event.type === 'addDir' || event.type === 'change') {
          if (path.basename(event.path) === targetName || event.path === targetPath) {
            void tryAccess();
          }
          // Fallback poller event: event.path is parentDir, bypass filename filter
          // because the whole point of fallback is to catch missed native events.
          else if (event.type === 'change' && event.path === parentDir) {
            void tryAccess();
          }
        }
      },
      {
        persistent: false,
        stability: 'immediate',
        recursive: false,
        // phase 368: watcher ready 后再 check 一次闭合 race
        // (chokidar ignoreInitial: true → 'ready' 前出现的 file 不 fire 'add')
        onReady: () => { void tryAccess(); },
      },
    );
    const timer = setTimeout(
      () => onSettle(new Error(`waitForPathExists timeout: ${targetPath} did not appear in ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

/**
 * Wait for a path (file or dir) to disappear.
 * phase 368: event-driven file-watcher on parent dir 替 fs.access polling.
 *
 * 与 waitForPathExists 对称：监父 dir 的 'unlink' / 'unlinkDir' 事件触发 access check。
 * 若 initial check 已 ENOENT 立即 resolve。
 */
export async function waitForPathGone(
  targetPath: string,
  timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS,
): Promise<void> {
  // initial check
  try {
    await access(targetPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }

  const parentDir = path.dirname(targetPath);
  const targetName = path.basename(targetPath);

  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const onSettle = (err?: Error): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      watcher.close().catch(() => { /* silent: cleanup */ });
      if (err) reject(err); else resolve();
    };
    const tryCheck = async (): Promise<void> => {
      try {
        await access(targetPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') onSettle();
        else onSettle(e as Error);
      }
    };
    const watcher = createWatcher(
      parentDir,
      (event) => {
        if (event.type === 'unlink' || event.type === 'unlinkDir') {
          if (path.basename(event.path) === targetName || event.path === targetPath) {
            void tryCheck();
          }
        }
        // Fallback poller event: event.path is parentDir, bypass filename filter
        // because the whole point of fallback is to catch missed native events.
        else if (event.type === 'change' && event.path === parentDir) {
          void tryCheck();
        }
      },
      {
        persistent: false,
        stability: 'immediate',
        recursive: false,
        // phase 368: watcher ready 后再 check 一次闭合 race
        // (chokidar ignoreInitial: true → 'ready' 前已 unlink 的 path 不 fire 'unlink')
        onReady: () => { void tryCheck(); },
      },
    );
    const timer = setTimeout(
      () => onSettle(new Error(`waitForPathGone timeout: ${targetPath} still exists after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}

/**
 * Wait for any file in `dir` whose name matches `predicate`.
 * phase 368: event-driven file-watcher 替 readdir + filter polling.
 *
 * 返回首个匹配的 filename（basename、不含 dir）.
 * 与 waitForPathExists/Gone 同模式：initial readdir / 父 dir ensure / watcher / onReady 兜底.
 */
export async function waitForAnyFile(
  dir: string,
  predicate: (filename: string) => boolean,
  timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS,
): Promise<string> {
  // initial check
  try {
    const files = await readdir(dir);
    const match = files.find(predicate);
    if (match !== undefined) return match;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // 父 dir 不存在则创（idempotent）
  await mkdir(dir, { recursive: true });

  // 再 check 一次（match 可能在 mkdir 期间出现）
  try {
    const files = await readdir(dir);
    const match = files.find(predicate);
    if (match !== undefined) return match;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  return new Promise<string>((resolve, reject) => {
    let resolved = false;
    const onSettle = (val: string | Error): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      watcher.close().catch(() => { /* silent: cleanup */ });
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    const tryCheck = async (): Promise<void> => {
      try {
        const files = await readdir(dir);
        const match = files.find(predicate);
        if (match !== undefined) onSettle(match);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onSettle(e as Error);
      }
    };
    const watcher = createWatcher(
      dir,
      (event) => {
        if (event.type === 'add' || event.type === 'change') {
          const filename = path.basename(event.path);
          if (predicate(filename)) void tryCheck();
        }
      },
      {
        persistent: false,
        stability: 'immediate',
        recursive: false,
        onReady: () => { void tryCheck(); },
      },
    );
    const timer = setTimeout(
      () => onSettle(new Error(`waitForAnyFile timeout: no file matching predicate in ${dir} after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
}
