/**
 * @module L6.CLI.Subagent.Steps
 * subagent steps + step commands
 */

export async function subagentStepsCommand(id: string, clawId: string): Promise<void> {
  console.log(`Steps for subagent ${id} on claw ${clawId} (placeholder)`);
}

export async function subagentStepCommand(n: number, id: string, clawId: string): Promise<void> {
  console.log(`Step ${n} for subagent ${id} on claw ${clawId} (placeholder)`);
}
