/**
 * Phase 1260 Step B: contract notification owner boundary ratchet.
 *
 * 单一职责：notification 职责与物理位置一致——
 *  - Runtime（L4 core/runtime）不再中转 notification sink（0 contractNotifyCallback /
 *    setOnNotify / ContractNotificationSink）；
 *  - ContractSystem 目录（core/contract）不含 L6 Assembly module marker，也不含
 *    transport adapter（notifyInbox self-inbox 写归 Assembly）；
 *  - Assembly 物理持有 adapter（assembly/contract-notification-adapter.ts），
 *    只 import ContractSystem-owned protocol types + Messaging/Stream capabilities。
 *
 * Phase 1262 Step D：`ContractNotification` type-only 判定兼容两种合法形态——
 * 整条 `import type { ... }` 与 mixed import 中的 `type ContractNotification`
 * specifier（Phase 1262 Step B 引入 owner encoder value + notification type 的
 * 合法 mixed import）；value-only import 与 deep import 仍拒绝。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function findOffenders(dir: string, pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of listTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    if (pattern.test(text)) offenders.push(path.relative(srcRoot, file));
  }
  return offenders;
}

/**
 * phase 1262 Step D: `ContractNotification` 必须从 ContractSystem 稳定 barrel 以
 * type-only 方式导入的两种合法形态。两个明确 pattern、不用可选 `(?:type\s+)?`
 * 包住 specifier（否则 `import { ContractNotification }` 会误通过）；`[^}]*`
 * 天然跨行，保留 `s` flag 与 word boundary 防相似类型名误配；mixed import 内
 * specifier 顺序不依赖。
 */
const CONTRACT_NOTIFICATION_TYPE_IMPORTS = [
  /import\s+type\s+\{[^}]*\bContractNotification\b[^}]*\}\s+from\s+'\.\.\/core\/contract\/index\.js'/s,
  /import\s+\{[^}]*\btype\s+ContractNotification\b[^}]*\}\s+from\s+'\.\.\/core\/contract\/index\.js'/s,
] as const;

function hasContractNotificationTypeImport(text: string): boolean {
  return CONTRACT_NOTIFICATION_TYPE_IMPORTS.some(pattern => pattern.test(text));
}

describe('phase 1260 Step B: contract notification owner boundary', () => {
  it('src/core/runtime/** 不含 contractNotifyCallback / setOnNotify / ContractNotificationSink', () => {
    const offenders = findOffenders(
      path.join(srcRoot, 'core', 'runtime'),
      /contractNotifyCallback|setOnNotify|ContractNotificationSink/,
    );
    expect(offenders).toEqual([]);
  });

  it('src/core/contract/** 不含 L6 Assembly module marker / notifyInbox transport 写', () => {
    const markerOffenders = findOffenders(
      path.join(srcRoot, 'core', 'contract'),
      /@module\s+L6\.Assembly/,
    );
    expect(markerOffenders).toEqual([]);
    const transportOffenders = findOffenders(
      path.join(srcRoot, 'core', 'contract'),
      /notifyInbox/,
    );
    expect(transportOffenders).toEqual([]);
  });

  it('src/assembly/contract-notification-adapter.ts 物理存在且只经 owner protocol 接 event', () => {
    const adapterPath = path.join(srcRoot, 'assembly', 'contract-notification-adapter.ts');
    expect(fs.existsSync(adapterPath)).toBe(true);
    const text = fs.readFileSync(adapterPath, 'utf8');
    expect(text).toContain('@module L6.Assembly');
    expect(hasContractNotificationTypeImport(text)).toBe(true);
    expect(text).toContain('createContractNotificationAdapter');
    // 旧物理位置不得残留 shim/兼容 re-export
    expect(fs.existsSync(path.join(srcRoot, 'core', 'contract', 'contract-notify-callback.ts'))).toBe(false);
  });

  it('反向 fixture：type-only 判定接受 type-only/mixed、拒绝 value-only/deep import', () => {
    expect(hasContractNotificationTypeImport(
      "import type { ContractNotification } from '../core/contract/index.js';",
    )).toBe(true);
    expect(hasContractNotificationTypeImport(
      "import { encodeX, type ContractNotification } from '../core/contract/index.js';",
    )).toBe(true);
    expect(hasContractNotificationTypeImport(
      "import { type ContractNotificationSink, type ContractNotification } from '../core/contract/index.js';",
    )).toBe(true);
    // value-only import 不得通过
    expect(hasContractNotificationTypeImport(
      "import { ContractNotification } from '../core/contract/index.js';",
    )).toBe(false);
    // deep import（非稳定 barrel）不得通过
    expect(hasContractNotificationTypeImport(
      "import type { ContractNotification } from '../core/contract/notification.js';",
    )).toBe(false);
    // 缺失 import 不得通过
    expect(hasContractNotificationTypeImport(
      "import { notifyInbox } from '../foundation/messaging/index.js';",
    )).toBe(false);
  });

  it('反向 fixture：scanner 能检出 runtime 中转与 contract 目录 adapter 回流', () => {
    const runtimePattern = /contractNotifyCallback|setOnNotify|ContractNotificationSink/;
    expect(runtimePattern.test('deps.contractManager.setOnNotify(deps.contractNotifyCallback);')).toBe(true);
    expect(runtimePattern.test('readonly contractNotifyCallback?: ContractNotificationSink;')).toBe(true);
    expect(runtimePattern.test('const sessionManager = deps.sessionManager;')).toBe(false);
    expect(/notifyInbox/.test("import { notifyInbox } from '../../foundation/messaging/index.js';")).toBe(true);
    expect(/notifyInbox/.test("import { notifyClaw } from '../../foundation/messaging/index.js';")).toBe(false);
  });
});
