import * as api from "./api";

let registered = false;

export function registerPluginModules(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "orca2-plugin-api",
    setup(build) {
      build.module("orca2/plugin", () => ({ exports: { ...api }, loader: "object" }));
      build.module("orca2/plugin/testing", async () => ({ exports: { ...await import("./api-testing") }, loader: "object" }));
    },
  });
}
