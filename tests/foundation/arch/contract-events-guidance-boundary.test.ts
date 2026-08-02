/**
 * Phase 1261 Step B: contract events guidance owner boundary ratchet.
 *
 * 单一职责：contract_events persisted guidance state 的 schema 归 ContractSystem 独占——
 *  - 两个 production writer（Assembly contract-notification-adapter 与
 *    contract-observer cron）必须经 owner encoder 写 v1 wire；
 *  - 唯一 consumer（phase 1266 Step A 后为 Assembly contract-events typed binding）
 *    必须经 owner decoder 取 typed refs，不得再出现 raw owner dialect
 *    （source_claw / contract_id / problem_pairs / JSON.parse / CSV split / ID regex）；
 *  - owner codec（core/contract/contract-events-guidance.ts）不得 import
 *    Assembly / CLIProtocol；
 *  - writer 不得手写 v1/legacy owner wire key。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

const ADAPTER = path.join(srcRoot, 'assembly', 'contract-notification-adapter.ts');
const OBSERVER = path.join(srcRoot, 'core', 'contract', 'jobs', 'contract-observer.ts');
/** 唯一 consumer 文件（phase 1266 Step A：composer 原子迁为 typed binding）。 */
const CONSUMER = path.join(srcRoot, 'assembly', 'guidance', 'bindings', 'contract-events.ts');
const CODEC = path.join(srcRoot, 'core', 'contract', 'contract-events-guidance.ts');

/** owner wire key 字面（v1 + 两套 legacy dialect），writer/composer 均不得手写。 */
const OWNER_WIRE_KEYS = /guidance_schema_version|contract_refs|source_claw|problem_pairs/;

describe('phase 1261 Step B: contract events guidance owner boundary', () => {
  it('两个 production writer 必须引用 owner encoder', () => {
    for (const file of [ADAPTER, OBSERVER]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, path.relative(srcRoot, file)).toContain('encodeContractEventsGuidance');
    }
  });

  it('consumer（typed binding）必须引用 owner decoder', () => {
    const text = fs.readFileSync(CONSUMER, 'utf8');
    expect(text).toContain('decodeContractEventsGuidance');
  });

  it('consumer（typed binding）不得出现 raw owner dialect（wire keys / JSON.parse / CSV split / ID regex）', () => {
    const text = fs.readFileSync(CONSUMER, 'utf8');
    expect(text).not.toMatch(OWNER_WIRE_KEYS);
    expect(text).not.toContain('contract_id');
    expect(text).not.toContain('JSON.parse');
    expect(text).not.toContain(".split(',')");
    expect(text).not.toMatch(/A-Za-z0-9_-/);
  });

  it('owner codec 不得 import Assembly / CLIProtocol', () => {
    const text = fs.readFileSync(CODEC, 'utf8');
    expect(text).not.toMatch(/from '[^']*assembly/);
    expect(text).not.toMatch(/from '[^']*cli-protocol/);
    expect(text).not.toContain('@module L6');
  });

  it('writer 不得手写 v1/legacy owner wire key（contract_events 路径）', () => {
    // contract_events single path 不再写 legacy keys extraFields；
    // adapter 的 contract_cancelled path 保留自家 legacy keys（本 phase 不治理）
    const adapter = fs.readFileSync(ADAPTER, 'utf8');
    const completedBlock = adapter.split("event.type === 'contract_completed'")[1]
      .split("event.type === 'contract_cancelled'")[0];
    expect(completedBlock).not.toMatch(OWNER_WIRE_KEYS);
    expect(completedBlock).not.toContain('contract_id');

    // observer 的 contract_events 投递 block 不得手写 wire keys；
    // contract_cancelled 投递 block（cancellations JSON）保留自家 dialect（本 phase 不治理）
    const observer = fs.readFileSync(OBSERVER, 'utf8');
    const eventsBlock = observer.split("type: 'contract_events'")[1]
      .split("type: 'contract_cancelled'")[0];
    expect(eventsBlock).not.toMatch(OWNER_WIRE_KEYS);
    expect(eventsBlock).not.toContain('contract_id');
  });

  it('反向 fixture：scanner 能检出 consumer raw dialect 与 writer 手写 wire key', () => {
    expect(OWNER_WIRE_KEYS.test("extraFields: { problem_pairs: pairs.join(',') },")).toBe(true);
    expect(OWNER_WIRE_KEYS.test('state.source_claw && state.contract_id')).toBe(true);
    expect(OWNER_WIRE_KEYS.test('guidance_schema_version: "1",')).toBe(true);
    expect(OWNER_WIRE_KEYS.test('const refs = decodeContractEventsGuidance(input);')).toBe(false);
    expect(/JSON\.parse/.test('const parsed = JSON.parse(raw);')).toBe(true);
    expect(/\.split\(','\)/.test("raw.split(',').map(s => s.trim())")).toBe(true);
    expect(/A-Za-z0-9_-/.test('const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;')).toBe(true);
  });
});
