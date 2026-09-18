import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1860 (RT-D1a): Runtime llm capability boundary', () => {
  it('owner defines LLMRuntimeCapability with exactly the four consumed operations', () => {
    const types = read('src/foundation/llm-orchestrator/types.ts');
    const orchestrator = read('src/foundation/llm-orchestrator/orchestrator.ts');
    const barrel = read('src/foundation/llm-orchestrator/index.ts');
    const body = types.match(
      /export interface LLMRuntimeCapability \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(4);
    for (const member of ['getProviderInfo(', 'resetLastSuccessProvider(', 'reloadConfig(', 'close(']) {
      expect(body).toContain(member);
    }
    expect(orchestrator).toContain('implements LLMOrchestrator, LLMOrchestratorOwner, LLMRuntimeCapability');
    expect(barrel).toContain('LLMRuntimeCapability');
  });

  it('Runtime holds the narrow capability and declares the forwarding surface separately', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(types).toContain('readonly llm: LLMRuntimeCapability;');
    expect(types).toContain('readonly llmOrchestrator: LLMOrchestrator;');
    expect(types).not.toContain('readonly llm: LLMOrchestrator;');
    // 单一存储 + 双类型视图：窄消费面视图与转发面视图同源（_llmImpl）。
    expect(runtime).toContain('private _llmImpl!: LLMOrchestrator;');
    expect(runtime).toContain('protected get llm(): LLMRuntimeCapability');
    expect(runtime).toContain('protected get llmOrchestrator(): LLMOrchestrator');
    expect(runtime).not.toContain('protected llm!: LLMOrchestrator;');
  });

  it('Runtime private consumption of this.llm stays within the four capability methods', () => {
    const runtime = read('src/core/runtime/runtime.ts');
    const consumed = new Set(
      [...runtime.matchAll(/this\.llm\.([A-Za-z]+)\s*(\?\.)?\(/g)].map((m) => m[1]),
    );

    expect(consumed.size).toBeGreaterThan(0);
    for (const method of consumed) {
      expect(['getProviderInfo', 'resetLastSuccessProvider', 'reloadConfig', 'close']).toContain(method);
    }
  });

  it('forwarding points consume llmOrchestrator and Assembly injects the same object without casts', () => {
    const runtime = read('src/core/runtime/runtime.ts');
    const assembly = read('src/assembly/runtime-assembly.ts');

    // ExecContext 构造与 runReact 转发面必须经 llmOrchestrator（非窄消费面）。
    expect(runtime).toContain('llm: this.llmOrchestrator');
    expect(runtime).not.toMatch(/llm:\s*this\.llm[,;\s]/);
    // Assembly：两字段注入同一对象、无显式 cast。
    expect(assembly).toMatch(/llm:\s*recoverySession\.llm,\s*\n\s*llmOrchestrator:\s*recoverySession\.llm,/);
    expect(assembly).not.toMatch(/llm:\s*recoverySession\.llm\s+as\s+/);
  });
});
