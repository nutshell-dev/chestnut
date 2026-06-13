import type {
  isAlive as defaultIsAlive,
  kill as defaultKill,
  isPidArgvMatching as defaultIsPidArgvMatching,
} from '../foundation/process-exec/index.js';

export interface WatchdogProcessDeps {
  kill?: typeof defaultKill;
  isAlive?: typeof defaultIsAlive;
  // phase 346 B3: argv-verify seam — tests use 假 PID 不实跑 ps、必须可 mock
  isPidArgvMatching?: typeof defaultIsPidArgvMatching;
}
