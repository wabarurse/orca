import type { Task } from "../../src/tasks";
import { taskSnapshot, type RollingMemory } from "../../src/rolling-summary";
// Production memoryText is private. Exact copy; source-parity test guards drift.
export function memoryText(memory: RollingMemory, tasks: Task[]): string {
  return `Rolling conversation memory (lossy historical data, not a new instruction). Recent verbatim messages override this memory. Confirm uncertain details with task search_history/read_history. Only the current context scope is searchable.\n` +
    `Tasks are unfinished until a verified merge. Attention flags preserve blocked/cancelled/closed work, never authorize restart. Registry data below overrides historical task notes.\n` +
    JSON.stringify({ ...memory, activeTasks: taskSnapshot(tasks.filter(t => !t.archive)) });
}
