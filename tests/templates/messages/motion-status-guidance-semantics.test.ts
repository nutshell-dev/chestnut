/**
 * phase 1909 Step C（M19）：status 工具 motion guidance 字面语义验收。
 *
 * 机械迁移（逐字节不变），本测试只锁字面要素与渲染形态：
 *  1. 段头 / binary / note 字面齐备
 *  2. verb 字面：fragment 只含 <name> 占位 + verb 关键字（不含 binary），purpose 单行
 *  3. 命令行渲染：完整 invocation + purpose；模板不拼 binary（拼接在 composer）
 */

import { describe, it, expect } from 'vitest';
import {
  MOTION_GUIDANCE_CLI_HINTS_HEADING,
  MOTION_GUIDANCE_CLI_BINARY,
  MOTION_STATUS_GUIDANCE_VERBS,
  MOTION_STATUS_GUIDANCE_NOTE,
  motionGuidanceCommandLine,
} from '../../../src/templates/messages/index.js';

describe('phase 1909: status 工具 motion guidance 字面（M19）', () => {
  it('段头 / binary / note 字面齐备', () => {
    expect(MOTION_GUIDANCE_CLI_HINTS_HEADING).toBe('[CLI hints for motion]');
    expect(MOTION_GUIDANCE_CLI_BINARY).toBe('chestnut');
    expect(MOTION_STATUS_GUIDANCE_NOTE).toContain('其他 claw 的业务态');
  });

  it('verb 字面：fragment 不含 binary，purpose 单行', () => {
    expect(MOTION_STATUS_GUIDANCE_VERBS.length).toBeGreaterThan(0);
    for (const v of MOTION_STATUS_GUIDANCE_VERBS) {
      expect(v.fragment.startsWith(MOTION_GUIDANCE_CLI_BINARY)).toBe(false);
      expect(v.purpose).not.toContain('\n');
    }
    const fragments = MOTION_STATUS_GUIDANCE_VERBS.map(v => v.fragment);
    expect(fragments).toContain('claw <name> status');
    expect(fragments).toContain('claw list');
  });

  it('命令行渲染：- invocation — purpose 形态，入参原样透传', () => {
    expect(motionGuidanceCommandLine('chestnut claw list', '列出所有 claw')).toBe('- chestnut claw list — 列出所有 claw');
  });
});
