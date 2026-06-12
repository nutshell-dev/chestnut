import type * as readline from 'readline';

/**
 * readline.Interface 私有 API `_writeToOutput` 显式 augment
 * （M#9「不可消除耦合显式表达」+ 编译期可检 method 签名 / 替历史 `(rl as any)._writeToOutput`）
 */
export type ReadlineWithWriteToOutput = readline.Interface & {
  _writeToOutput?: (str: string) => void;
};

/**
 * Read a password from readline with echo suppressed via _writeToOutput mute.
 * Restores original writer in try/catch + question callback 双路径、防 private API 丢失或异常时残留 mute 状态。
 *
 * 抽自 cli/commands/{start,init}.ts inline passwordQuestion N=2 dup（phase 829 F fork）。
 */
export function passwordQuestion(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  return new Promise((resolve) => {
    const rlx = rl as ReadlineWithWriteToOutput;
    let muted = false;
    const original = rlx._writeToOutput?.bind(rl);
    const restore = () => {
      try { rlx._writeToOutput = original; } catch {
        // silent: readline private API _writeToOutput unavailable / readline disposed — restore best-effort, no user impact
      }
    };
    try {
      rlx._writeToOutput = (str: string) => { if (!muted) original?.(str); };
      rl.question(prompt, (answer) => {
        muted = false;
        restore();
        process.stdout.write('\n');
        resolve(answer.trim());
      });
      muted = true;
    } catch (err) {
      restore();
      throw err;
    }
  });
}
