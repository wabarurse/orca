import { expect, test } from "bun:test";
import { readViewer, saveViewer, viewerEnv, viewerHere } from "./viewer";

const env = { PATH: "/bin", REX_SESSION: "session:hidden", REX_BLOCK: "block:daemon" };

test("an agent's Rex location is the user's orca2 pane, or none when nobody watches", () => {
  const viewer = viewerHere({ REX_SESSION: "session:user", REX_BLOCK: "block:pane" }, process.pid);
  expect(viewerEnv(env, viewer)).toEqual({ PATH: "/bin", REX_SESSION: "session:user", REX_BLOCK: "block:pane" });
  expect(viewerEnv(env, null)).toEqual({ PATH: "/bin" });
  expect(viewerEnv(env, viewerHere({}, process.pid))).toEqual({ PATH: "/bin" });
});

test("a viewer record whose orca2 has exited reads as nobody watching", async () => {
  await saveViewer("c-gone", { pid: 2 ** 22 + 7, rexSession: "session:user", rexBlock: "block:old" });
  expect(await readViewer("c-gone")).toBeNull();
  await saveViewer("c-here", viewerHere({ REX_SESSION: "session:user", REX_BLOCK: "block:pane" }, process.pid));
  expect(await readViewer("c-here")).toEqual({ pid: process.pid, rexSession: "session:user", rexBlock: "block:pane" });
});
