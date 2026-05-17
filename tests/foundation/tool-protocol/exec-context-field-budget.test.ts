import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('ExecContext field budget (phase 968 升档条件 mechanical enforcement)', () => {
  it('ExecContext interface members count ≤ 35 (phase 808 升档条件 a)', () => {
    const filePath = path.resolve(
      __dirname,
      '../../../src/foundation/tool-protocol/index.ts'
    );
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true
    );
    let memberCount = -1;
    sourceFile.forEachChild((node) => {
      if (
        ts.isInterfaceDeclaration(node) &&
        node.name.text === 'ExecContext'
      ) {
        memberCount = node.members.length;
      }
    });
    expect(memberCount).toBeGreaterThan(0); // sanity
    expect(memberCount).toBeLessThanOrEqual(35); // phase 808 升档条件 (a) threshold
  });

  it('single-reader fields cluster size ≤ 3 (phase 808 升档条件 b)', () => {
    // single-reader candidate fields (现 2: systemPromptForLLM + toolsForLLM)
    const candidates = ['systemPromptForLLM', 'toolsForLLM'];

    // grep src/ excluded tests/ 数 reader file count per field
    const srcDir = path.resolve(__dirname, '../../../src');

    function countReaderFiles(fieldName: string): Set<string> {
      const readers = new Set<string>();
      function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(fullPath);
          else if (entry.isFile() && entry.name.endsWith('.ts')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            // match ctx.<fieldName> 或 .<fieldName> 模式 (跨变量名)
            const re = new RegExp(`\\.${fieldName}(?![a-zA-Z_])`);
            if (re.test(content)) {
              // 提取 module-level dir 作为 reader unit
              const rel = path.relative(srcDir, fullPath);
              const moduleId = rel.split(path.sep).slice(0, 2).join('/');
              readers.add(moduleId);
            }
          }
        }
      }
      walk(srcDir);
      return readers;
    }

    // 统计单 reader fields = 仅 1 reader module 的 candidate
    const singleReaderFields = candidates.filter((f) => {
      const readers = countReaderFiles(f);
      return readers.size === 1;
    });

    expect(singleReaderFields.length).toBeLessThanOrEqual(3); // phase 808 升档条件 (b) threshold
  });
});
