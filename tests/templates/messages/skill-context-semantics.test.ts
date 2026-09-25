/**
 * phase 1909 Step C（M17）：技能上下文段字面语义验收。
 *
 * 机械迁移（逐字节不变），本测试只锁结构要素：
 *  1. 段头 / 空态 / 缺省描述字面齐备
 *  2. 技能行：name + description 原样透传（缺省回退判断留在调用方）
 */

import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_SKILLS_HEADING,
  NO_SKILLS_LOADED,
  SKILL_NO_DESCRIPTION,
  skillLine,
} from '../../../src/templates/messages/index.js';

describe('phase 1909: 技能上下文段字面（M17）', () => {
  it('段头 / 空态 / 缺省描述字面齐备', () => {
    expect(AVAILABLE_SKILLS_HEADING).toBe('## Available Skills');
    expect(NO_SKILLS_LOADED).toBe('No skills loaded.');
    expect(SKILL_NO_DESCRIPTION).toBe('No description');
  });

  it('技能行：- name: description 形态，入参原样透传', () => {
    expect(skillLine('skill-x', 'desc-x')).toBe('- skill-x: desc-x');
    expect(skillLine('s', '')).toBe('- s: ');
  });
});
