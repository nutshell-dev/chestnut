/**
 * dispatch-skills 路径 const — EvolutionSystem own per phase 1228。
 *
 * CLI 写入、SummonSystem 读取（summon 上下文）、EvolutionSystem 读取（retro 上下文）。
 * 放在 EvolutionSystem 避免 EvolutionSystem → SummonSystem 反向依赖造成的循环。
 */
export const DISPATCH_SKILLS_SUBDIR = 'dispatch-skills' as const;
export const DISPATCH_SKILLS_PATH = `clawspace/${DISPATCH_SKILLS_SUBDIR}` as const;
