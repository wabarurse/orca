import { join } from "node:path";
import type { BuiltinPlugin } from "../core/plugins";

const dir = (name: string): string => join(import.meta.dir, name);

export const BUILTINS: BuiltinPlugin[] = [
  { name: "example", dir: dir("example"), index: () => import("./example/index"), ui: () => import("./example/ui"), background: () => import("./example/background") },
  { name: "questions", dir: dir("questions"), index: () => import("./questions/index"), ui: () => import("./questions/ui"), background: null },
  { name: "tasks", dir: dir("tasks"), index: () => import("./tasks/index"), ui: () => import("./tasks/ui"), background: () => import("./tasks/background") },
  { name: "pr-watch", dir: dir("pr-watch"), index: () => import("./pr-watch/index"), ui: () => import("./pr-watch/ui"), background: () => import("./pr-watch/background") },
  { name: "processes", dir: dir("processes"), index: () => import("./processes/index"), ui: () => import("./processes/ui"), background: () => import("./processes/background") },
  { name: "images", dir: dir("images"), index: () => import("./images/index"), ui: () => import("./images/ui"), background: null },
  { name: "sandbox", dir: dir("sandbox"), index: () => import("./sandbox/index"), ui: () => import("./sandbox/ui"), background: null },
  { name: "tmux", dir: dir("tmux"), index: () => import("./tmux/index"), ui: () => import("./tmux/ui"), background: () => import("./tmux/background") },
  { name: "rex", dir: dir("rex"), index: () => import("./rex/index"), ui: () => import("./rex/ui"), background: () => import("./rex/background") },
];
