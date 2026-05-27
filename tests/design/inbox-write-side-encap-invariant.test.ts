import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

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
      '/Users/lleefir/code/mess/260315/worktree/phase1334',
    );
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(0);
  });

  it('cross-module hardcoded path.join inbox+pending baseline ratchet = 0 outside allowlist', () => {
    // allowlist: daemon (read/delete paths, no writes) + watchdog-utils (countMd read-only)
    const out = safeGrep(
      `grep -rn "path.join.*inbox.*pending" src/ --include='*.ts' | grep -v test | grep -v 'foundation/messaging' | grep -v 'assembly/' | grep -v 'cli/' | grep -v 'daemon/' | grep -v 'watchdog-utils'`,
      '/Users/lleefir/code/mess/260315/worktree/phase1334',
    );
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(0);
  });

  it('non-deprecated callers use notifyClaw or writeInboxAsync (deep-dream = notifyInbox self-notify exception)', () => {
    const outNotify = execSync(
      `grep -rn 'notifyClaw\\|writeInboxAsync' src/core src/watchdog src/core/memory src/core/contract --include='*.ts' | grep -v test`,
      { encoding: 'utf8', cwd: '/Users/lleefir/code/mess/260315/worktree/phase1334' },
    );
    expect(outNotify).toContain('heartbeat.ts');
    expect(outNotify).toContain('watchdog-cron.ts');
    expect(outNotify).toContain('watchdog-log.ts');
    expect(outNotify).toContain('random-dream.ts');
    expect(outNotify).toContain('result-delivery.ts');
    expect(outNotify).toContain('verification-notify.ts');
    expect(outNotify).toContain('contract-observer.ts');

    // deep-dream uses deprecated notifyInbox for self-notify (chrooted fs special case)
    const outInbox = execSync(
      `grep -rn 'notifyInbox' src/core/memory/deep-dream.ts`,
      { encoding: 'utf8', cwd: '/Users/lleefir/code/mess/260315/worktree/phase1334' },
    );
    expect(outInbox).toContain('deep-dream.ts');
  });
});
