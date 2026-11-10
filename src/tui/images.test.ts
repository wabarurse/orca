import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "../test/app-fixture";
import { png } from "../test/image-fixture";
import { paths } from "../config";
import { saveImage } from "../core/data/images";
import { open } from "../core/data/transcripts";
import { App } from "./app";
import { deliveredImages, deliveredImageData } from "./commands/images";
import { replyLines } from "./conversation/restore";

const { fakeTerm, until, raw } = appFixture();

test("Images has project-local counts, Vim selection and live refresh without losing selection", async () => {
  const project = "image-navigation", other = "image-empty";
  for (const name of [project, other]) mkdirSync(paths.project(name), { recursive: true });
  const record = open(paths.transcript(project, "orchestrator"));
  const empty = open(paths.transcript(other, "orchestrator"));
  const refs: Awaited<ReturnType<typeof saveImage>>[] = [];
  for (let n = 1; n <= 3; n++) {
    const ref = await saveImage(project, png(n, 2));
    refs.push(ref);
    await record.append({ type: "replies", messages: [{ from: "worker", text: `Screenshot ${n}`, attachments: [ref] }] });
  }
  const term = fakeTerm(120, 28), opened: string[] = [];
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    imageData: async (project, ref) => { opened.push(ref.id); return deliveredImageData(project, ref); },
    openOrchestrator: async name => ({ say: async () => {}, pending: async () => false, turn: async () => [],
      entries: () => (name === project ? record : empty).history!() }),
  });
  term.inlineImages = true;
  const running = app.run(project);
  try {
    await until(() => app.page?.project === project && app.status(app.page).endsWith("3 images"));
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type(" p"); await until(() => opened.at(-1) === refs[2]!.id);
    term.type("G"); await until(() => opened.at(-1) === refs[0]!.id);
    term.type("gg"); await until(() => opened.at(-1) === refs[2]!.id);
    term.type("j"); await until(() => opened.at(-1) === refs[1]!.id);
    const latest = await saveImage(project, png(4, 2));
    await record.append({ type: "replies", messages: [{ from: "worker", text: "Screenshot 4", attachments: [latest] }] });
    await app.refreshSessions();
    await until(() => term.screen().includes("Screenshot 4"));
    expect(opened.at(-1)).toBe(refs[1]!.id);
    const count = opened.length; term.press({ name: "enter" }); await Bun.sleep(30);
    expect(opened).toHaveLength(count);
    expect(app.status(app.page!)).toEndWith("4 images");
    term.type("k"); await until(() => opened.at(-1) === refs[2]!.id);
    await app.openPage(other);
    expect(app.status(app.page!)).toEndWith("0 images");
    term.type(" p"); await until(() => term.screen().includes("No images"));
    term.type("gT"); await until(() => app.page?.project === project);
    expect(app.status(app.page!)).toEndWith("4 images");
    term.type(" p"); await until(() => term.screen().includes("IMAGES"));
    term.resize(32, 14);
    await until(() => term.screen().includes("IMAGES"));
    term.type("G");
    await until(() => opened.at(-1) === refs[0]!.id);
  } finally { app.quit(); await running; }
});

test("delivered screenshots restore in chat, preview automatically on selection, and remain available after UI clear", async () => {
  const project = `media-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png(3, 2));
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "replies", messages: [{ from: "orchestrator", text: "Screenshot after the fix", attachments: [ref] }] });
  const term = fakeTerm(100, 28), opened: string[] = [];
  const app = new App({ term, pollMs: 100_000, imageData: async (project, ref) => { opened.push(ref.id); return deliveredImageData(project, ref); },
    agents: async () => [], watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }),
  });
  term.inlineImages = true;
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    expect(app.page!.lines.map(raw).join("\n")).toContain("/images to open");
    expect(opened).toEqual([]);
    term.type("/images\r"); await until(() => term.screen().includes("IMAGES") && term.screen().includes("Screenshot after the fix"));
    await until(() => opened.length === 1 && term.raw().includes("1337;File="));
    term.press({ name: "enter" }); await Bun.sleep(30);
    expect(opened).toEqual([ref.id]);
    expect(term.raw()).toContain(png(3, 2).toString("base64"));
    term.press({ name: "escape" });
    await until(() => !term.screen().includes("IMAGES"));
    term.type("/clear\r"); await until(() => app.page!.lines.length === 0);
    term.type("/images\r"); await until(() => term.screen().includes("IMAGES") && term.screen().includes("Screenshot after the fix"));
    await until(() => opened.length === 2);
  } finally { app.quit(); await running; }
});

test("picker indexes delivered images only, deduplicates repeated deliveries, and refuses modified bytes before rendering a preview", async () => {
  const project = `media-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png());
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "message", message: { role: "user", content: "ordinary prompt" } });
  expect(deliveredImages(record.history!())).toEqual([]);
  for (const text of ["first delivery", "latest delivery"]) await record.append({ type: "replies", messages: [{ from: "orchestrator", text, attachments: [ref] }] });
  expect(deliveredImages(record.history!()).map(row => row.text)).toEqual(["latest delivery"]);
  writeFileSync(join(paths.project(project), "images", `${ref.id}.png`), png(2, 1));
  await expect(deliveredImageData(project, ref)).rejects.toThrow("corrupt");
  expect(replyLines({ from: "orchestrator", text: "text only" })).toHaveLength(1);
});

test("slow previews cannot repaint a closed page; unsupported terminals never load or open a viewer", async () => {
  const project = "image-stale-preview";
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png());
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "replies", messages: [{ from: "worker", text: "Preview race", attachments: [ref] }] });
  let finish!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const term = fakeTerm(100, 28);
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    imageData: async (project, ref) => { reads++; await gate; return deliveredImageData(project, ref); },
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    term.type("/images\r"); await until(() => term.screen().includes("Update Hermit"));
    expect(reads).toBe(0);
    term.press({ name: "enter" }); expect(reads).toBe(0);
    term.inlineImages = true; app.draw(); await until(() => reads === 1);
    term.press({ name: "escape" }); await until(() => !term.screen().includes("IMAGES"));
    finish(); await Bun.sleep(40);
    expect(term.raw()).not.toContain("1337;File=");
    term.type("/images\r"); await until(() => term.display.imageWrites.length === 1);
    const count = term.display.imageWrites.length;
    await app.refreshSessions(); app.draw(); await Bun.sleep(40);
    expect(term.display.imageWrites).toHaveLength(count); // no repeated base64 transfer on polls
  } finally { finish(); app.quit(); await running; }
});
