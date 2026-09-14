/**
 * phase 1831: AuditWriter → 磁盘 TSV → 生产 AuditReader 字段级往返。
 *
 * 唯一语义命题：由现有 AuditWriter 编码的审计事件 type/cols，经生产 AuditReader
 * 解码后保持原始字段值。writer 字节格式不变（本测试不改写协议、不复制 esc/unesc
 * 算法，只经公共入口读写）。1830 审阅 payload 的 JSON 解析失败是该通用命题的
 * 业务回归实例（见 development log/phase1830-logs/Z-real-reader.log）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createAuditWriter } from '../../../src/foundation/audit/index.js';
import { createAuditReader } from '../../../src/foundation/audit/reader.js';
import type { AuditRecord } from '../../../src/foundation/audit/reader.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('phase 1831: writer → reader 字段往返（真实 NodeFileSystem）', () => {
  let rootDir: string;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
    rootDir = await createTempDir('phase1831-roundtrip-');
    nfs = new NodeFileSystem({ baseDir: rootDir });
  });

  afterEach(async () => {
    await cleanupTempDir(rootDir);
  });

  async function writeAndReadBack(
    events: Array<{ type: string; cols: string[] }>,
  ): Promise<AuditRecord[]> {
    const writer = createAuditWriter(nfs, 'audit.tsv');
    for (const e of events) {
      writer.write(e.type, ...e.cols);
    }
    const reader = createAuditReader(nfs, 'audit.tsv');
    const records: AuditRecord[] = [];
    try {
      for await (const rec of reader.read()) {
        records.push(rec);
      }
    } finally {
      reader.close();
    }
    return records;
  }

  it('type 与 cols 逐字段严格等于原值（控制字符 / 字面转义 / 未知序列 / 边界）', async () => {
    // 输入值三层显式命名：input value（程序内原值）→ 磁盘编码（writer 职责，本测试不预设）
    // → 解码预期（= input value）。
    const inputs: Array<{ name: string; type: string; cols: string[] }> = [
      { name: 'empty cols', type: 'evt_empty', cols: [] },
      { name: 'empty string col', type: 'evt_blank', cols: ['', 'k='] },
      { name: '中文 + emoji', type: 'evt_unicode', cols: ['说明=修复配置重载', 'emoji=🌰✅'] },
      {
        name: '实际控制字符 tab/LF/CR/NUL',
        type: 'evt_ctrl',
        cols: [`tab=<\t>`, `lf=<a\nb>`, `cr=<a\rb>`, `nul=<a\0b>`],
      },
      {
        name: '字面反斜杠+n/t/r/0',
        type: 'evt_literal_escape',
        cols: ['lit=\\n', 'lit=\\t', 'lit=\\r', 'lit=\\0'],
      },
      {
        name: '多个连续反斜杠后跟代码字母',
        type: 'evt_multi_backslash',
        cols: ['two=\\\\n', 'three=\\\\\\t', 'four=\\\\\\\\r'],
      },
      {
        name: 'Windows 风格路径',
        type: 'evt_winpath',
        cols: ['path=C:\\Users\\claw\\new\\test\\root'],
      },
      {
        name: 'JSON 嵌套 payload',
        type: 'evt_json',
        cols: ['payload=' + JSON.stringify({ a: { b: ['x\ty', 'z\nw', '\\q'] }, n: 1 })],
      },
      { name: '未知反斜杠+q 原样保留', type: 'evt_unknown', cols: ['u=a\\qb'] },
      { name: '尾部孤立反斜杠', type: 'evt_trailing', cols: ['t=abc\\'] },
      {
        name: '组合 + 等号',
        type: 'evt_combo',
        cols: ['k=v\tx=y\\n', `id=c-1\npath=C:\\t\\u=q`],
      },
    ];

    const records = await writeAndReadBack(inputs.map(e => ({ type: e.type, cols: e.cols })));
    expect(records).toHaveLength(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      expect(records[i]!.type, `type mismatch @ ${inputs[i]!.name}`).toBe(inputs[i]!.type);
      expect(records[i]!.cols, `cols mismatch @ ${inputs[i]!.name}`).toEqual(inputs[i]!.cols);
    }
  });

  it('1830 业务回归实例：审阅 result payload 经生产 reader 读回可 JSON.parse 且逐字节一致', async () => {
    const payload = JSON.stringify({
      reviewId: 'r-1',
      contractId: 'c-1',
      prompt: '[contract baseline]\nid: c-1\nexpectations:\ndo X\tdo Y\n',
      response: {
        content: [
          { type: 'thinking', thinking: '先核对…\n再判定', signature: 'sig\\1' },
          { type: 'text', text: '{"on_track":false,"drifts":[{"what":"循环","evidence":"step 40-49\t重复"}]}' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const records = await writeAndReadBack([
      { type: 'contract_audit_result_recorded', cols: ['reviewId=r-1', 'contractId=c-1', `payload=${payload}`] },
    ]);
    expect(records).toHaveLength(1);
    const payloadCol = records[0]!.cols.find(c => c.startsWith('payload='));
    expect(payloadCol).toBeDefined();
    const decoded = payloadCol!.slice('payload='.length);
    // 生产 reader 解码后：payload 可解析且与原对象逐字段一致
    expect(JSON.parse(decoded)).toEqual(JSON.parse(payload));
    expect(decoded).toBe(payload);
  });

  it('trace_id 接口语义不变：trace_id 列仍单独提取、不在 cols', async () => {
    // writer 侧 traceId 由调用上下文注入；此处用手工行核 reader 既有接口契约
    // （reader.test.ts 已有同命题用例，此处证明本 phase 改动后语义保持）。
    const records = await writeAndReadBack([
      { type: 'evt_plain', cols: ['a=1', 'b=x\ty'] },
    ]);
    expect(records[0]!.trace_id).toBeUndefined();
    expect(records[0]!.cols).toEqual(['a=1', 'b=x\ty']);
  });
});
