import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contextSource = readFileSync(
  new URL('../../../src/foundation/tools/context.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/tools/index.ts', import.meta.url),
  'utf8',
);

describe('Tools ExecContextImplOptions deep surface', () => {
  it('keeps the options interface local behind ExecContextImpl', () => {
    expect(contextSource).not.toMatch(/export\s+interface\s+ExecContextImplOptions\b/);
    expect(contextSource).toMatch(/(?:^|\n)interface\s+ExecContextImplOptions\s*\{/);

    // 6 required fields
    expect(contextSource).toMatch(/\n\s*clawId:\s*string;/);
    expect(contextSource).toMatch(/\n\s*clawDir:\s*string;/);
    expect(contextSource).toMatch(/\n\s*workspaceDir:\s*string;/);
    expect(contextSource).toMatch(/\n\s*syncDir:\s*string;/);
    expect(contextSource).toMatch(/\n\s*profile:\s*ToolProfile;/);
    expect(contextSource).toMatch(/\n\s*fs:\s*FileSystem;/);

    // 14 optional fields
    expect(contextSource).toMatch(/\n\s*fsFactory\?:\s*\(baseDir:\s*string\)\s*=>\s*FileSystem;/);
    expect(contextSource).toMatch(/\n\s*llm\?:\s*LLMOrchestrator;/);
    expect(contextSource).toMatch(/\n\s*signal\?:\s*AbortSignal;/);
    expect(contextSource).toMatch(/\n\s*auditWriter\?:\s*AuditLog;/);
    expect(contextSource).toMatch(/\n\s*currentToolUseId\?:\s*ToolUseId;/);
    expect(contextSource).toMatch(/\n\s*readFileState\?:\s*Map<string,\s*FileState>;/);
    expect(contextSource).toMatch(/\n\s*persistReadFileState\?:\s*boolean;/);
    expect(contextSource).toMatch(/\n\s*registry\?:\s*ToolRegistry;/);
    expect(contextSource).toMatch(/\n\s*baseRegistry\?:\s*ToolRegistry;/);
    expect(contextSource).toMatch(/\n\s*permissionChecker\?:\s*PermissionChecker;/);
    expect(contextSource).toMatch(/\n\s*toolTimeoutMs\?:\s*number;/);
    expect(contextSource).toMatch(/\n\s*trace_id\?:\s*TraceId;/);
    expect(contextSource).toMatch(
      /\n\s*getCallerSnapshot\?:\s*import\('\.\/types\.js'\)\.ExecContext\['getCallerSnapshot'\];/,
    );
    expect(contextSource).toMatch(/\n\s*subagentTaskId\?:\s*string;/);

    // constructor binding and key per-field assignments
    expect(contextSource).toMatch(/constructor\(options:\s*ExecContextImplOptions\)\s*\{/);
    expect(contextSource).toMatch(/\n\s*this\.clawId\s*=\s*options\.clawId;/);
    expect(contextSource).toMatch(/\n\s*this\.readFileState\s*=\s*options\.readFileState\s*\?\?\s*new Map\(\);/);
    expect(contextSource).toMatch(/\n\s*this\.subagentTaskId\s*=\s*options\.subagentTaskId;/);
    expect(contextSource).toMatch(/\n\s*this\.startTime\s*=\s*Date\.now\(\);/);

    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bExecContextImpl\b[^}]*\}\s*from\s*'\.\/context\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bExecContextImplOptions\b/);
  });
});
