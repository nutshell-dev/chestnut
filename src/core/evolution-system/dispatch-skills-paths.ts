import { CLAWSPACE_DIR } from '../../foundation/paths.js';

/** dispatch-skills 子目录名（路径 segment / 与 CLAWSPACE_DIR 拼接 / 资源归属 EvolutionSystem / phase411 物理迁自 skill/skill-paths.ts）*/
export const DISPATCH_SKILLS_SUBDIR = 'dispatch-skills' as const;

/** dispatch-skills 完整路径（resolved with motion baseDir 由 caller 自取 motionBaseDir + CLAWSPACE_DIR + DISPATCH_SKILLS_SUBDIR）*/
export const DISPATCH_SKILLS_PATH = `${CLAWSPACE_DIR}/${DISPATCH_SKILLS_SUBDIR}` as const;
