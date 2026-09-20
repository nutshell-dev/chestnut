/**
 * Phase 1873 Step G: startup cooldown 状态归 daemon-owned 路径 + legacy 读取兼容。
 *
 * 契约：
 * - 新路径 `<agentDir>/daemon/startup_check_ts` 为写出位置与首选读取；
 * - legacy `<agentDir>/status/startup_check_ts`（PM STATUS_SUBDIR）仅在新路径缺失时
 *   读取：旧值继续生效 + 迁移写新路径；旧文件不主动删除（跨版本双跑防丢状态）；
 * - 新路径存在时忽略 legacy；cooldown 判定值语义不变（10min）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { shouldEmitStartupCheck } from '../../src/daemon/startup-check.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { STARTUP_CHECK_COOLDOWN_MS } from '../../src/daemon/constants.js';

describe('phase 1873 Step G: startup-check 状态路径（daemon-owned + legacy 兼容）', () => {
  let dir: string;
  let audit: ReturnType<typeof makeAudit>['audit'];

  beforeEach(async () => {
    dir = await createTrackedTempDir('startup-ts-');
    ({ audit } = makeAudit());
  });

  afterEach(async () => {
    await cleanupTempDir(dir);
  });

  async function seedBase(): Promise<void> {
    await fs.mkdir(path.join(dir, 'inbox', 'pending'), { recursive: true });        // inbox empty
    await fs.mkdir(path.join(dir, 'contract', 'active', 'c-live'), { recursive: true }); // active 存在
  }

  async function writeTs(rel: string, ts: number): Promise<void> {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), String(ts));
  }

  function eligible(): boolean {
    return shouldEmitStartupCheck(new NodeFileSystem({ baseDir: dir }), audit);
  }

  const NEW = path.join('daemon', 'startup_check_ts');
  const LEGACY = path.join('status', 'startup_check_ts');

  it('新路径存在且冷却未过 → not eligible', async () => {
    await seedBase();
    await writeTs(NEW, Date.now());
    expect(eligible()).toBe(false);
  });

  it('新路径存在且冷却已过 → eligible', async () => {
    await seedBase();
    await writeTs(NEW, Date.now() - STARTUP_CHECK_COOLDOWN_MS - 1);
    expect(eligible()).toBe(true);
  });

  it('legacy-only：旧路径冷却未过 → 旧值被识别（not eligible）', async () => {
    await seedBase();
    await writeTs(LEGACY, Date.now());
    expect(eligible()).toBe(false);
  });

  it('legacy-only：旧值冷却已过 → eligible + 迁移写新路径（旧文件保留）', async () => {
    await seedBase();
    const oldTs = Date.now() - STARTUP_CHECK_COOLDOWN_MS - 1;
    await writeTs(LEGACY, oldTs);
    expect(eligible()).toBe(true);
    // 迁移写：新路径出现且值 = 旧值；旧文件不主动删除
    expect(fsNative.existsSync(path.join(dir, NEW))).toBe(true);
    expect(fsNative.readFileSync(path.join(dir, NEW), 'utf-8')).toBe(String(oldTs));
    expect(fsNative.existsSync(path.join(dir, LEGACY))).toBe(true);
  });

  it('双路径并存：新路径优先（legacy fresh 值不压制新路径的已过期值）', async () => {
    await seedBase();
    await writeTs(NEW, Date.now() - STARTUP_CHECK_COOLDOWN_MS - 1);  // 已过
    await writeTs(LEGACY, Date.now());                                // fresh
    expect(eligible()).toBe(true);
  });

  it('corrupt 新路径值 → 视为无冷却（eligible）+ 删除该文件', async () => {
    await seedBase();
    await writeTs(NEW, Number.NaN);
    expect(eligible()).toBe(true);
    expect(fsNative.existsSync(path.join(dir, NEW))).toBe(false);
  });
});
