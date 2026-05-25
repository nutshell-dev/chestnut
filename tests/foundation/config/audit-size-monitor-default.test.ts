/**
 * Phase 1230 B-3 E.5 β-1h — audit_size_monitor schedule default
 *
 * Covers:
 *   default schedule = interval:1h (was interval:6h)
 *   reverse: schema regex accepts 'interval:1h'
 *   reverse: revert to 6h → test would fail
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { createClawGlobalConfigSchema } = await import('../../../src/foundation/config/schemas.js');
const { CONFIG_DEFAULTS } = await import('../../../src/assembly/config-defaults.js');

const Schema = createClawGlobalConfigSchema(CONFIG_DEFAULTS);

describe('audit_size_monitor default schedule (phase 1230 E.5 β-1h)', () => {
  it('显式提供 audit_size_monitor 空对象时默认 schedule = interval:1h', () => {
    const config = Schema.parse({
      llm: { primary: { api_key: 'test' } },
      cron: {
        jobs: {
          audit_size_monitor: {},
        },
      },
    });
    expect(config.cron?.jobs?.audit_size_monitor?.schedule).toBe('interval:1h');
  });

  it('schema regex 接受 interval:1h', () => {
    const config = Schema.parse({
      llm: { primary: { api_key: 'test' } },
      cron: {
        jobs: {
          audit_size_monitor: {
            enabled: true,
            schedule: 'interval:1h',
          },
        },
      },
    });
    expect(config.cron?.jobs?.audit_size_monitor?.schedule).toBe('interval:1h');
  });

  it('反向: 源码中 default 不再是 interval:6h', () => {
    const schemaPath = path.resolve('src/foundation/config/schemas.ts');
    const content = fs.readFileSync(schemaPath, 'utf-8');
    // 确认 audit_size_monitor 的 default 是 1h
    expect(content).toContain("default('interval:1h')");
  });
});
