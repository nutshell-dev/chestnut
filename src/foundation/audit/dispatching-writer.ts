/**
 * @module L2a.AuditLog
 * DispatchingAuditWriter (phase 159、phase 122 §5.A impl).
 *
 * α + β 混合形态：
 * - 实现 AuditLog 接口（α 单 dispatcher、调用方零感知）
 * - 内部 own multi AuditWriter instance（β 多 instance、各自独立 seq / rotation）
 * - 按 type 路由（装配期 typeToFile spec 注入）
 *
 * Invariants:
 * - AuditLog.write(type, ...cols) 接口零变更（M#7）
 * - 调用方零感知 file 路由（M#5 + M#8）
 * - 每物理 file 独立 seq counter（M#1）
 * - 未注册 type → 兜底 default 'audit' file（DP 不丢弃静默忽略）
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from './types.js';
import { AuditWriter } from './writer.js';
import { clipPreview, clipMessage, clipSummary } from './_helpers.js';

export class DispatchingAuditWriter implements AuditLog {
  readonly __brand = 'AuditLog' as const;

  private readonly writers: Map<string, AuditWriter>;
  private readonly typeToFile: ReadonlyMap<string, string>;
  private readonly defaultFile: string;

  constructor(
    fs: FileSystem,
    baseDir: string,
    typeToFile: ReadonlyMap<string, string>,
    options?: { maxSizeMb?: number | null; defaultFile?: string },
  ) {
    this.typeToFile = typeToFile;
    this.defaultFile = options?.defaultFile ?? 'audit'; // 'audit' 是 cross-process 字面契约

    // collect distinct file names + ensure defaultFile included
    const fileNames = new Set([this.defaultFile, ...typeToFile.values()]);

    this.writers = new Map();
    for (const name of fileNames) {
      const filePath = path.join(baseDir, `${name}.tsv`);
      this.writers.set(name, new AuditWriter(fs, filePath, options?.maxSizeMb));
    }
  }

  write(type: string, ...cols: (string | number)[]): void {
    const fileName = this.typeToFile.get(type) ?? this.defaultFile;
    const writer = this.writers.get(fileName) ?? this.writers.get(this.defaultFile);
    if (!writer) {
      // 不可预期失败（defaultFile writer 也缺）→ 暴露
      throw new Error(
        `DispatchingAuditWriter: no writer for type=${type} file=${fileName} (default=${this.defaultFile})`,
      );
    }
    writer.write(type, ...cols);
  }

  dispose(): void {
    // 联级 dispose 全部 internal writers
    for (const writer of this.writers.values()) {
      writer.dispose?.();
    }
  }

  preview(s: string): string { return clipPreview(s); }
  message(s: string): string { return clipMessage(s); }
  summary(s: string): string { return clipSummary(s); }

  /** Get internal AuditWriter for a specific file (testing / inspection only). */
  _getWriterForFile(fileName: string): AuditWriter | undefined {
    return this.writers.get(fileName);
  }
}
