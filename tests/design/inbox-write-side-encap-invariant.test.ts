import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

// phase 1491: cwd 改 process.cwd() / 原硬编码 worktree/phase1334 在 CI + 其他 worktree 上不存在
const REPO_CWD = process.cwd();

function safeGrep(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd });
  } catch {
    // grep exit 1 = no matches, which is the desired state
    return '';
  }
}

describe('inbox write-side encap invariant (phase 1334 r138 E fork)', () => {
  it('cross-module `new InboxWriter` baseline ratchet = 0 outside allowlist', () => {
    // allowlist: src/foundation/messaging/ (codec owner) + src/assembly/ (装配端)
    // + src/cli/ (CLI 入口) + src/foundation/messaging/tools/ (motion LLM tool)
    const out = safeGrep(
      `grep -rn 'new InboxWriter' src/ --include='*.ts' | grep -v test | grep -v 'foundation/messaging' | grep -v 'assembly/' | grep -v 'cli/' | grep -v 'foundation/messaging/tools/'`,
      REPO_CWD,
    );
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(0);
  });

  // phase 315 Step A: path.join inbox+pending hardcoded ratchet 已迁移为
  // ESLint custom rule `no-hardcoded-inbox-path`。本 grep invariant 删除。
  // phase 705: L4 ClawTopology 提供 routeNotifyClaw 包装器，等价于 notifyClaw 调用站点。

  it('non-deprecated callers use notifyClaw or writeInboxAsync (deep-dream = notifyInbox self-notify exception)', () => {
    const outNotify = execSync(
      `grep -rn 'notifyClaw\\|routeNotifyClaw\\|writeInboxAsync' src/core src/watchdog src/core/memory src/core/contract --include='*.ts' | grep -v test`,
      { encoding: 'utf8', cwd: REPO_CWD },
    );
    expect(outNotify).toContain('heartbeat.ts');
    expect(outNotify).toContain('watchdog-cron.ts');
    expect(outNotify).toContain('watchdog-log.ts');
    expect(outNotify).toContain('random-dream.ts');
    expect(outNotify).toContain('result-delivery.ts');
    expect(outNotify).toContain('verification-notify.ts');

    // deep-dream uses deprecated notifyInbox for self-notify (chrooted fs special case)
    // phase 1493: grep -rn 单文件在 BSD (macOS) vs GNU (Linux) 输出格式差
    //   BSD: `file.ts:N:content`（含 filename prefix）
    //   GNU: `N:content`（单文件不带 filename prefix）
    // 故 assertion 绑 content (notifyInbox) 而非 filename string、跨平台稳定。
    const outInbox = execSync(
      `grep -rn 'notifyInbox' src/core/memory/deep-dream.ts`,
      { encoding: 'utf8', cwd: REPO_CWD },
    );
    expect(outInbox).toMatch(/notifyInbox/);
  });
});
