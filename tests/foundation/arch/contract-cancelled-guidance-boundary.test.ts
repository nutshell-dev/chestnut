/**
 * Phase 1262 Step B: contract cancelled guidance owner boundary ratchet.
 *
 * 单一职责：contract_cancelled persisted guidance state 的 schema 归 ContractSystem 独占——
 *  - 两个 production writer（Assembly contract-notification-adapter 与
 *    contract-observer cron）必须经 owner encoder 写 v1 wire；
 *  - 唯一 consumer（Assembly contract-cancelled composer）必须经 owner decoder 取
 *    typed refs，不得再出现 raw owner dialect（source_claw / contract_id / reason /
 *    cancellations / JSON.parse / 逐项 filter / `(unknown)` / `(no reason given)` 默认值）；
 *  - owner codec（core/contract/contract-cancelled-guidance.ts）不得 import
 *    Assembly / CLIProtocol，不得复用 contract-events-guidance.ts 内部实现；
 *  - writer 的 contract_cancelled 投递 block 不得手写 v1/legacy owner wire key。
 *
 * ratchet 按具体 event block 切片：adapter 的 stream legacy payload
 * （toLegacyNotifyData 的 contractId/reason camel/snake 混排）与 observer 其他业务
 * （completed body reason、event-collector entry.reason）均不在本 ratchet 范围。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

const ADAPTER = path.join(srcRoot, 'assembly', 'contract-notification-adapter.ts');
const OBSERVER = path.join(srcRoot, 'core', 'contract', 'jobs', 'contract-observer.ts');
const COMPOSER = path.join(srcRoot, 'assembly', 'guidance', 'composers', 'contract-cancelled.ts');
const CODEC = path.join(srcRoot, 'core', 'contract', 'contract-cancelled-guidance.ts');

/** owner wire key 字面（v1 + 两套 legacy dialect），writer/composer 均不得手写。 */
const OWNER_WIRE_KEYS = /guidance_schema_version|cancelled_contract_refs|source_claw|cancellations/;

describe('phase 1262 Step B: contract cancelled guidance owner boundary', () => {
  it('两个 production writer 必须引用 owner encoder', () => {
    for (const file of [ADAPTER, OBSERVER]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, path.relative(srcRoot, file)).toContain('encodeContractCancelledGuidance');
    }
  });

  it('composer 必须引用 owner decoder', () => {
    const text = fs.readFileSync(COMPOSER, 'utf8');
    expect(text).toContain('decodeContractCancelledGuidance');
  });

  it('composer 不得出现 raw owner dialect（wire keys / JSON.parse / filter / 伪默认值）', () => {
    const text = fs.readFileSync(COMPOSER, 'utf8');
    expect(text).not.toMatch(OWNER_WIRE_KEYS);
    expect(text).not.toContain('contract_id');
    expect(text).not.toContain('reason');
    expect(text).not.toContain('JSON.parse');
    expect(text).not.toContain('.filter(');
    expect(text).not.toContain('(unknown)');
    expect(text).not.toContain('no reason given');
    expect(text).not.toMatch(/A-Za-z0-9_-/);
  });

  it('owner codec 不得 import Assembly / CLIProtocol 或复用 contract-events codec 实现', () => {
    const text = fs.readFileSync(CODEC, 'utf8');
    expect(text).not.toMatch(/from '[^']*assembly/);
    expect(text).not.toMatch(/from '[^']*cli-protocol/);
    expect(text).not.toContain('@module L6');
    expect(text).not.toMatch(/from '[^']*contract-events-guidance/);
  });

  it('writer 不得手写 v1/legacy owner wire key（contract_cancelled 投递 block）', () => {
    // adapter 的 contract_cancelled block：只经 owner encoder 写 extraFields；
    // toLegacyNotifyData 的 stream legacy payload（contractId/reason）不在本 block 范围
    const adapter = fs.readFileSync(ADAPTER, 'utf8');
    const cancelledBlock = adapter.split("event.type === 'contract_cancelled'")[1]
      .split('};')[0];
    expect(cancelledBlock).not.toMatch(OWNER_WIRE_KEYS);
    expect(cancelledBlock).not.toContain('contract_id');
    expect(cancelledBlock).not.toContain('reason');

    // observer 的 contract_cancelled 投递 block：只经 owner encoder 写 extraFields；
    // cancelledEvents body（含 reason）与 watermark/audit 不在本 block 范围
    const observer = fs.readFileSync(OBSERVER, 'utf8');
    const deliveryBlock = observer.split("type: 'contract_cancelled'")[1]
      .split('} catch')[0];
    expect(deliveryBlock).not.toMatch(OWNER_WIRE_KEYS);
    expect(deliveryBlock).not.toContain('contract_id');
    expect(deliveryBlock).not.toContain('reason');
  });

  it('反向 fixture：scanner 能检出 composer raw dialect 与 writer 手写 wire key', () => {
    expect(OWNER_WIRE_KEYS.test("extraFields: { cancellations: JSON.stringify(list) },")).toBe(true);
    expect(OWNER_WIRE_KEYS.test('state.source_claw && state.contract_id')).toBe(true);
    expect(OWNER_WIRE_KEYS.test('guidance_schema_version: "1",')).toBe(true);
    expect(OWNER_WIRE_KEYS.test("cancelled_contract_refs: '[...]',")).toBe(true);
    expect(OWNER_WIRE_KEYS.test('const refs = decodeContractCancelledGuidance(input);')).toBe(false);
    expect(/JSON\.parse/.test('const parsed = JSON.parse(raw);')).toBe(true);
    expect(/\.filter\(/.test('parsed.filter(e => isValid(e))')).toBe(true);
    expect(/\(unknown\)/.test("source_claw: state.source_claw ?? '(unknown)',")).toBe(true);
    expect(/no reason given/.test("reason: state.reason ?? '(no reason given)',")).toBe(true);
  });
});
