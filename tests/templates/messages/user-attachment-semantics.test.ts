/**
 * phase 1909 Step B（M15）：用户长消息附件包装正文语义验收。
 *
 * 本测试只锁系统行要素与透传纪律，不锁句式标点：
 *  1. 系统行齐备（size 行 / path 行 / preview 头行 / read 工具提示行）
 *  2. preview（用户原文渲染结果）原样透传，模板不改写
 *  3. size/head 计数与入参一致（模板不自造数字）
 */

import { describe, it, expect } from 'vitest';
import { userAttachmentBody } from '../../../src/templates/messages/index.js';

describe('phase 1909: 用户附件包装正文（M15）', () => {
  it('系统行齐备且计数与入参一致', () => {
    const body = userAttachmentBody({
      sizeChars: 3000,
      attachmentRelPath: '../inbox/attachments/1_a.txt',
      previewHeadChars: 200,
      preview: 'HEAD',
    });
    expect(body).toContain('[user-input attachment: 3000 chars]');
    expect(body).toContain('path: ../inbox/attachments/1_a.txt');
    expect(body).toContain('preview (first 200 chars):');
    expect(body).toContain('Use the read tool to fetch full or partial content (supports offset/limit).');
  });

  it('preview 原样透传（含特殊字符与多行，模板不改写用户原文渲染结果）', () => {
    const preview = 'line1 ${not-interpolated}\nline2 "quoted" `tick`';
    const body = userAttachmentBody({
      sizeChars: 42,
      attachmentRelPath: '../inbox/attachments/x.txt',
      previewHeadChars: 7,
      preview,
    });
    const lines = body.split('\n');
    // preview 占 preview 头行之后、空行之前的行段，逐字节相等
    const headIdx = lines.findIndex(l => l === 'preview (first 7 chars):');
    expect(headIdx).toBeGreaterThan(-1);
    expect(lines[headIdx + 1]).toBe('line1 ${not-interpolated}');
    expect(lines[headIdx + 2]).toBe('line2 "quoted" `tick`');
    expect(body).toContain(preview);
  });

  it('size/head 数字不补造：不同入参渲染不同计数', () => {
    const body = userAttachmentBody({
      sizeChars: 5,
      attachmentRelPath: 'p',
      previewHeadChars: 3,
      preview: 'abc',
    });
    expect(body).toContain('5 chars]');
    expect(body).toContain('first 3 chars');
    expect(body).not.toContain('200 chars');
  });
});
