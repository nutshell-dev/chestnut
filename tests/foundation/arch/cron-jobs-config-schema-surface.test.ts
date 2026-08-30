import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/cron/config-schema.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/cron/index.ts', import.meta.url),
  'utf8',
);

describe('Cron cronJobsConfigSchema deep surface', () => {
  it('keeps the jobs schema local behind cronConfigSchema', () => {
    expect(configSchemaSource).not.toMatch(/export\s+const\s+cronJobsConfigSchema\b/);
    expect(configSchemaSource).toMatch(/(?:^|\n)const\s+cronJobsConfigSchema\s*=\s*z\.object\(\{/);
    // four job keys
    expect(configSchemaSource).toMatch(/\n\s*dream_trigger:\s*z\.object\(\{/);
    expect(configSchemaSource).toMatch(/\n\s*contract_observer:\s*z\.object\(\{/);
    expect(configSchemaSource).toMatch(/\n\s*audit_size_monitor:\s*z\.object\(\{/);
    expect(configSchemaSource).toMatch(/\n\s*outbox_summary:\s*z\.object\(\{/);
    // core fields / defaults
    expect(configSchemaSource).toMatch(
      /dream_trigger:\s*z\.object\(\{\s*\n\s*enabled:\s*z\.boolean\(\)\.default\(false\),\s*\n\s*schedule:\s*cronJobScheduleField\.default\('daily:04:00'\),\s*\n\s*max_compression_tokens:\s*z\.number\(\)\.min\(500\)\.max\(20000\)\.default\(4000\),\s*\n\s*\}\)\.default\(\{\}\),/,
    );
    const enabledTrueDefaults = configSchemaSource.match(
      /(?:contract_observer|audit_size_monitor|outbox_summary):\s*z\.object\(\{\s*\n\s*enabled:\s*z\.boolean\(\)\.default\(true\),/g,
    );
    expect(enabledTrueDefaults).toHaveLength(3);
    // parent schema binding
    expect(configSchemaSource).toMatch(/jobs:\s*cronJobsConfigSchema\.default\(\{\}\),/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bcronConfigSchema\b[^}]*\}\s*from\s*'\.\/config-schema\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bcronJobsConfigSchema\b/);
  });
});
