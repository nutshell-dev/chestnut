import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1928: Runtime turn-event stream 投递单 owner（AgentExecutor 经 streamCallbacks）', () => {
  it('stepCallbacks 不透传 AgentExecutor 已有的三类 turn 事件回调', () => {
    const source = read('src/core/runtime/runtime.ts');
    expect(source).not.toMatch(/onTextEnd:\s*callbacks\?\.onTextEnd/);
    expect(source).not.toMatch(/onToolCall:\s*callbacks\?\.onToolCall/);
    expect(source).not.toMatch(/onToolResult:\s*callbacks\?\.onToolResult/);
  });

  it('streamCallbacks 整对象投递通道保持存在', () => {
    expect(read('src/core/runtime/runtime.ts')).toMatch(/streamCallbacks:\s*callbacks/);
  });
});
