/**
 * Phase 1760 Step B: ForumStatusDeps 未使用依赖 ratchet
 * （STATUS-FORUM-UNUSED-BASEDIR-COUPLING）。
 *
 * baseDir 曾是跨边界必填但实现零读取的耦合参数；删除后以此 source ratchet
 * 防止未使用字段回流（不得用 optional 字段或索引签名掩盖耦合）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const FORUM_AGGREGATORS_SRC = path.resolve(
  __dirname,
  '../../../src/core/status-service/forum-aggregators.ts',
);

describe('phase 1760: ForumStatusDeps unused-field ratchet', () => {
  it('ForumStatusDeps declares no baseDir field', () => {
    const src = readFileSync(FORUM_AGGREGATORS_SRC, 'utf8');
    const m = src.match(/export interface ForumStatusDeps \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const body = m![1].replace(/\/\/[^\n]*/g, ''); // 剥离行注释、防注释串词
    // 字段声明形态（含 optional）；fsFactory 回调形参名不在此列
    expect(body).not.toMatch(/^\s*baseDir(\?)?\s*:/m);
  });
});
