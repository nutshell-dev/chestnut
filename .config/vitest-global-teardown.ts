import * as fs from 'node:fs';

export default function globalTeardown(): void {
  const runRoot = process.env.CHESTNUT_RUN_ROOT;
  if (!runRoot) return;

  // 如果所有 worker 都正常结束（runRoot 下的临时目录都已被 worker 清理），
  // runRoot 应该为空或接近空，直接删除。
  try {
    fs.rmSync(runRoot, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[vitest-teardown] failed to remove run root ${runRoot}: ${err}\n`);
  }
}
