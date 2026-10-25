/**
 * Phase 1997 Step B: viewport identity 纯函数覆盖。
 *
 * identity 唯一判据 = ClawLocation.kind；label/目录名恰为 'motion' 的
 * 普通 claw（用户极端测试 fixture）不得被判为系统 Motion。
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveViewportRoots } from '../../src/viewport/viewport-identity.js';
import type { ClawLocation } from '../../src/core/claw-topology/index.js';

describe('viewport-identity: resolveViewportRoots (phase 1997)', () => {
  it('motion location：agentDir=clawDir，chestnutRoot=dirname，isMotion=true', () => {
    const location: ClawLocation = { kind: 'motion', clawDir: '/x/.chestnut/motion' };
    const roots = resolveViewportRoots(location);
    expect(roots.agentDir).toBe('/x/.chestnut/motion');
    expect(roots.chestnutRoot).toBe('/x/.chestnut');
    expect(roots.isMotion).toBe(true);
  });

  it('普通 claw location：chestnutRoot=clawDir 上两级，isMotion=false', () => {
    const location: ClawLocation = { kind: 'claw', clawDir: '/x/.chestnut/claws/search' };
    const roots = resolveViewportRoots(location);
    expect(roots.agentDir).toBe('/x/.chestnut/claws/search');
    expect(roots.chestnutRoot).toBe('/x/.chestnut');
    expect(roots.isMotion).toBe(false);
  });

  it('目录名恰为 motion 的普通 claw（legacy fixture 形态）：仍判 isMotion=false', () => {
    const location: ClawLocation = { kind: 'claw', clawDir: '/x/.chestnut/claws/motion' };
    const roots = resolveViewportRoots(location);
    expect(roots.agentDir).toBe('/x/.chestnut/claws/motion');
    expect(roots.chestnutRoot).toBe('/x/.chestnut');
    expect(roots.isMotion).toBe(false);
  });

  it('相对路径 clawDir：chestnutRoot 解析为绝对上两级', () => {
    const location: ClawLocation = { kind: 'claw', clawDir: '.chestnut/claws/foo' };
    const roots = resolveViewportRoots(location);
    expect(roots.isMotion).toBe(false);
    expect(path.isAbsolute(roots.chestnutRoot)).toBe(true);
    expect(roots.chestnutRoot.endsWith('.chestnut')).toBe(true);
  });
});
