// The built-in plugins, imported statically so the compiled binary carries them.
import { join } from "node:path";
import type { BuiltinPlugin } from "../core/plugins";

const dir = (name: string): string => join(import.meta.dir, name);

export const BUILTINS: BuiltinPlugin[] = [
  { name: "example", dir: dir("example"), index: () => import("./example/index"), ui: () => import("./example/ui"), background: () => import("./example/background") },
];
