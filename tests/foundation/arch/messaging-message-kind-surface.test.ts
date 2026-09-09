import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const invariantsSource = readFileSync(
  new URL('../../../src/foundation/messaging/invariants.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging MessageKind deep surface', () => {
  it('keeps the message kind type local behind assertMessageShape', () => {
    expect(invariantsSource).not.toMatch(/export\s+type\s+MessageKind\b/);
    expect(invariantsSource).toMatch(
      /(?:^|\n)type\s+MessageKind\s*=\s*'inbox'\s*\|\s*'outbox';/,
    );
    expect(invariantsSource).toMatch(/(?:^|\n)\s*kind:\s*MessageKind,/);
    // phase 1824: checkId 的 audit 参数已收窄为 MessagingAuditSink，不再绑定
    // 提供者 Audit 类型；此处只锚定 checkId 的 kind 参数类型不回流/不外泄。
    const source = ts.createSourceFile('invariants.ts', invariantsSource, ts.ScriptTarget.Latest, true);
    const checkId = source.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'checkId',
    );
    if (!checkId) throw new Error('checkId declaration missing');
    const parameter = checkId.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === 'kind');
    expect(parameter?.type?.getText(source)).toBe('MessageKind');
    expect(barrelSource).not.toMatch(/\bMessageKind\b/);
  });
});
