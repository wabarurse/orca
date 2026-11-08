import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "../test/app-fixture";
import { png } from "../test/image-fixture";
import { paths } from "../config";
import { saveImage } from "../core/data/images";
import { open } from "../core/data/transcripts";
import { App } from "./app";
import { deliveredImages, openDeliveredImage } from "./commands/images";
import { replyLines } from "./conversation/restore";

const { fakeTerm, until, raw } = appFixture();

test("delivered screenshots restore in chat, open only after selection, and remain available after UI clear", async () => {
  const project = `media-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png(3, 2));
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "replies", messages: [{ from: "orchestrator", text: "Screenshot after the fix", attachments: [ref] }] });
  const term = fakeTerm(100, 28), opened: string[] = [];
  const app = new App({ term, pollMs: 100_000, openImage: async path => { opened.push(path); },
    agents: async () => [], watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    expect(app.page!.lines.map(raw).join("\n")).toContain("/images to open");
    expect(opened).toEqual([]);
    term.type("/images\r"); await until(() => !!app.menu);
    expect(app.menu!.items.join("\n")).toContain(ref.id.slice(0, 8));
    expect(opened).toEqual([]);
    term.press({ name: "enter" }); await until(() => opened.length === 1);
    expect(await Bun.file(opened[0]!).bytes()).toEqual(new Uint8Array(png(3, 2)));
    term.type("/clear\r"); await until(() => app.page!.lines.length === 0);
    term.type("/images\r"); await until(() => !!app.menu);
    expect(app.menu!.items.join("\n")).toContain(ref.id.slice(0, 8));
  } finally { app.quit(); await running; }
});

test("picker indexes delivered images only, deduplicates repeated deliveries, and refuses modified bytes before launching a viewer", async () => {
  const project = `media-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png());
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "message", message: { role: "user", content: "ordinary prompt" } });
  expect(deliveredImages(record.history!())).toEqual([]);
  for (const text of ["first delivery", "latest delivery"]) await record.append({ type: "replies", messages: [{ from: "orchestrator", text, attachments: [ref] }] });
  expect(deliveredImages(record.history!()).map(row => row.text)).toEqual(["latest delivery"]);
  writeFileSync(join(paths.project(project), "images", `${ref.id}.png`), png(2, 1));
  let opened = false;
  await expect(openDeliveredImage(project, ref, async () => { opened = true; })).rejects.toThrow("corrupt");
  expect(opened).toBe(false);
  expect(replyLines({ from: "orchestrator", text: "text only" })).toHaveLength(1);
});
