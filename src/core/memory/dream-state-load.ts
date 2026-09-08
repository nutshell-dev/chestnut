/**
 * @module L4.MemorySystem dream-state-load
 *
 * phase 1810 Step B（MEMORY-DEEP-STATE-CORRUPT-OVERWRITE）：
 * dream state 文件 typed load + quarantine 单一 owner policy——deep-dream 与
 * random-dream 共用，不复制逻辑。
 *
 * 冻结四态（coding plan/phase1810 Step A）：found | absent | malformed | unavailable。
 * - malformed（parse/shape 损坏）：raw 原文必须 quarantine（原子 rename、唯一后缀、
 *   不覆盖旧 raw），不得隐式转 found/default；quarantine 失败也须保留证据、
 *   不得覆盖原文件。
 * - unavailable（EACCES/EIO 等系统故障）：不读不写、不 quarantine，degraded 保留证据。
 * - absent（ENOENT 首启）：良性，caller 走默认 state。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

/** dream state 文件原始 load 结果（schema 解释归各 dream 模块，本层只分型） */
export type DreamStateRawLoad =
  | { kind: 'found'; raw: Record<string, unknown> }
  | { kind: 'absent' }
  | { kind: 'malformed'; raw: string; error: string }
  | { kind: 'unavailable'; error: string };

export function loadDreamStateRaw(fs: FileSystem, stateFile: string): DreamStateRawLoad {
  let text: string;
  try {
    text = fs.readSync(stateFile);
  } catch (err) {
    // FileNotFoundError 首启良性；其余 IO 故障 = unavailable（不归 malformed）
    if (isFileNotFound(err)) return { kind: 'absent' };
    return { kind: 'unavailable', error: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'malformed', raw: text, error: `state_not_object:${Array.isArray(parsed) ? 'array' : typeof parsed}` };
    }
    return { kind: 'found', raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { kind: 'malformed', raw: text, error: formatErr(err) };
  }
}

/** quarantine 结果：成功携带新路径；失败保留原始 error（原文件不动） */
export type DreamStateQuarantine =
  | { kind: 'quarantined'; path: string }
  | { kind: 'failed'; error: string };

/**
 * 原子 quarantine：`rename(stateFile → stateFile.corrupt-N)`，N 取首个不存在
 * 后缀——幂等且不覆盖历史 raw（phase 1810 Step A 风险项）；moveSync 失败时
 * 原文件保持原位，绝不因隔离失败而覆盖/丢失原始证据。
 */
export function quarantineDreamStateRaw(fs: FileSystem, stateFile: string): DreamStateQuarantine {
  try {
    for (let n = 1; ; n++) {
      const candidate = `${stateFile}.corrupt-${n}`;
      if (!fs.existsSync(candidate)) {
        fs.moveSync(stateFile, candidate);
        return { kind: 'quarantined', path: candidate };
      }
    }
  } catch (err) {
    return { kind: 'failed', error: formatErr(err) };
  }
}

/**
 * typed degraded evidence：malformed 携带 quarantine 结果；unavailable 未触碰
 * 文件（无 quarantine 字段）。caller 据此阻断本轮 run，不得隐式 reset/save。
 */
export type DreamStateDegraded =
  | { cause: 'malformed'; error: string; quarantine: DreamStateQuarantine }
  | { cause: 'unavailable'; error: string };
