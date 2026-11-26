/**
 * Phase 2248 G4: Shadow owns conversion of legacy payloads to explicit input.
 * The former Assembly runtime payload-adapter path is intentionally not retained.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildShadowPayload,
  decodeLegacyShadowPayload,
  prepareShadowInput,
} from '../../../src/core/shadow-system/index.js';
import { decodeSubagentInput } from '../../../src/core/subagent/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import { makeAudit } from '../../helpers/audit.js';
import { cleanupTempDir, createTempDir } from '../../utils/temp.js';

const parentTools: ToolDefinition[] = [{
  name: 'read',
  description: 'read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
}];

describe('Shadow explicit execution input (phase 2248 G4)', () => {
  let tempDir: string;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    const audit = makeAudit();
    ctx = new ExecContextImpl({
      clawId: 'parent-claw',
      clawDir: tempDir,
      profile: 'full',
      fs: new NodeFileSystem({ baseDir: tempDir }),
      auditWriter: audit.audit,
      currentToolUseId: 'tu-parent',
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function legacyPayload() {
    return buildShadowPayload({
      task: 'branch task',
      mainMessages: [{ role: 'user', content: 'parent context' }],
      ctx,
      systemPrompt: 'parent system prompt',
      toolsForLLM: parentTools,
      timeoutMs: 12_345, // time-fixture: persisted declaration, not a wait budget
      maxSteps: 7,
      idleTimeoutMs: 999, // time-fixture: persisted declaration, not a wait budget
      postProcessor: 'summon-contract-extract',
    });
  }

  it('freezes the parent prompt, messages, canonical tools/manifest, restrictions and capture', () => {
    const payload = legacyPayload();
    const input = prepareShadowInput(payload);

    expect(input).toMatchObject({
      schema_version: 1,
      kind: 'prepared_subagent_input',
      prompt: '',
      systemPrompt: { kind: 'text', text: payload.systemPrompt },
      toolProfile: 'full',
      budget: { timeoutMs: 12_345, maxSteps: 7, idleTimeoutMs: 999 }, // time-fixture: bounded prepared-input payload assertion
      resultCapture: { toolName: 'done' },
      execution: {
        callerKind: 'shadow',
        allowDone: true,
        allowShadow: false,
        allowSummon: false,
        allowNotifyClaw: false,
        manifestRevision: payload.manifestRevision,
      },
    });
    expect(input.messages).toEqual(payload.messages);
    expect(input.tools.manifest.llmTools).toEqual(payload.toolsForLLM);
    expect(input.tools.manifest.revision).toBe(payload.manifestRevision);
    expect(decodeSubagentInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it('decodes only its own valid legacy payload and never defaults unknown shapes', () => {
    const payload = legacyPayload();
    expect(decodeLegacyShadowPayload(payload)).toMatchObject({ kind: 'decoded', value: payload });
    expect(decodeLegacyShadowPayload(undefined)).toEqual({ kind: 'not_applicable' });
    expect(decodeLegacyShadowPayload({ owner: 'another-system' })).toEqual({ kind: 'not_applicable' });
    expect(decodeLegacyShadowPayload({ ...payload, detached: false })).toMatchObject({ kind: 'invalid' });
    expect(decodeLegacyShadowPayload({ ...payload, messages: 'damaged' })).toMatchObject({ kind: 'invalid' });
    expect(decodeLegacyShadowPayload({ ...payload, toolsForLLM: [{ name: 'broken' }] })).toMatchObject({ kind: 'invalid' });
  });

  it('keeps a source manifest conflict visible instead of rebuilding under its revision', () => {
    const payload = { ...legacyPayload(), manifestRevision: '0'.repeat(64) };
    expect(() => prepareShadowInput(payload)).toThrow(/shadow manifest revision mismatch/);
    expect(decodeLegacyShadowPayload(payload)).toMatchObject({
      kind: 'invalid',
      reason: expect.stringMatching(/manifest revision mismatch/),
    });
  });
});
