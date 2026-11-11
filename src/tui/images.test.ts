import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFixture } from "../test/app-fixture";
import { png } from "../test/image-fixture";
import { paths } from "../config";
import { saveImage } from "../core/data/images";
import { open } from "../core/data/transcripts";
import { App } from "./app";
import { deliveredImages, openDeliveredMedia } from "./commands";
import { replyLines } from "./conversation/restore";

const { fakeTerm, until, raw } = appFixture();

test("Images uses project-local counts and Vim selection; only Enter opens a viewer", async () => {
  const project = "image-navigation", other = "image-empty";
  for (const name of [project, other]) mkdirSync(paths.project(name), { recursive: true });
  const record = open(paths.transcript(project, "orchestrator"));
  const empty = open(paths.transcript(other, "orchestrator"));
  const refs: Awaited<ReturnType<typeof saveImage>>[] = [];
  for (let n = 1; n <= 3; n++) {
    const ref = await saveImage(project, png(n, 2)); refs.push(ref);
    await record.append({ type: "replies", messages: [{ from: "worker", text: `Screenshot ${n}`, attachments: [ref] }] });
  }
  const term = fakeTerm(120, 28), opened: string[] = [];
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    openMedia: (project, media) => openDeliveredMedia(project, media, async () => { opened.push(media.id); }),
    openOrchestrator: async name => ({ say: async () => {}, pending: async () => false, turn: async () => [],
      entries: () => (name === project ? record : empty).history!() }),
  });
  term.inlineImages = true;
  const running = app.run(project);
  const select = (text: string) => term.display.screen().some(row => row.startsWith(`› ${text}`));
  try {
    await until(() => app.page?.project === project && app.status(app.page).endsWith("3 images"));
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type("P"); await until(() => select("Screenshot 3"));
    term.type("G"); await until(() => select("Screenshot 1"));
    term.type("gg"); await until(() => select("Screenshot 3"));
    term.type("j"); await until(() => select("Screenshot 2"));
    expect(opened).toEqual([]);
    term.press({ name: "enter" }); await until(() => opened.length === 1);
    expect(opened).toEqual([refs[1]!.id]);
    const latest = await saveImage(project, png(4, 2));
    await record.append({ type: "replies", messages: [{ from: "worker", text: "Screenshot 4", attachments: [latest] }] });
    await app.refreshSessions();
    await until(() => term.screen().includes("Screenshot 4"));
    expect(select("Screenshot 2")).toBe(true);
    expect(app.status(app.page!)).toEndWith("4 images");
    term.type("k"); await until(() => select("Screenshot 3"));
    await app.openPage(other);
    expect(app.status(app.page!)).toEndWith("0 images");
    term.type("P"); await until(() => term.screen().includes("No images"));
    term.type("gT"); await until(() => app.page?.project === project);
    term.type("P"); await until(() => term.screen().includes("IMAGES"));
    term.resize(32, 14); await until(() => term.screen().includes("IMAGES"));
    term.type("G"); await until(() => select("Screenshot 1"));
    term.press({ name: "enter" }); await until(() => opened.length === 2);
    expect(opened[1]).toBe(refs[0]!.id);
    expect(term.raw()).not.toContain("1337;File=");
  } finally { app.quit(); await running; }
});

test("delivered screenshots restore in chat and survive UI clear without inline transfer or automatic popups", async () => {
  const project = `media-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png(3, 2));
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "replies", messages: [{ from: "orchestrator", text: "Screenshot after the fix", attachments: [ref] }] });
  const term = fakeTerm(100, 28), opened: string[] = [];
  const app = new App({ term, pollMs: 100_000,
    openMedia: (project, media) => openDeliveredMedia(project, media, async () => { opened.push(media.id); }),
    agents: async () => [], watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }),
  });
  term.inlineImages = true;
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    expect(app.page!.lines.map(raw).join("\n")).toContain("/images to open");
    term.type("/images\r"); await until(() => term.screen().includes("IMAGES") && term.screen().includes("Screenshot after the fix"));
    expect(opened).toEqual([]);
    term.press({ name: "enter" }); await until(() => opened.length === 1);
    expect(opened).toEqual([ref.id]);
    expect(term.raw()).not.toContain(png(3, 2).toString("base64"));
    expect(term.raw()).not.toContain("1337;File=");
    term.press({ name: "escape" }); await until(() => !term.screen().includes("IMAGES"));
    term.type("/clear\r"); await until(() => app.page!.lines.length === 0);
    term.type("/images\r"); await until(() => term.screen().includes("IMAGES") && term.screen().includes("Screenshot after the fix"));
    expect(opened).toHaveLength(1);
  } finally { app.quit(); await running; }
});

test("picker deduplicates delivered images and refuses modified bytes before opening the viewer", async () => {
  const project = `media-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png());
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "message", message: { role: "user", content: "ordinary prompt" } });
  expect(deliveredImages(record.history!())).toEqual([]);
  for (const text of ["first delivery", "latest delivery"]) await record.append({ type: "replies", messages: [{ from: "orchestrator", text, attachments: [ref] }] });
  const images = deliveredImages(record.history!());
  expect(images.map(row => row.text)).toEqual(["latest delivery"]);
  writeFileSync(join(paths.project(project), "images", `${ref.id}.png`), png(2, 1));
  let opened = false;
  await expect(openDeliveredMedia(project, { ...images[0]!, kind: "image", id: ref.id }, async () => { opened = true; })).rejects.toThrow("corrupt");
  expect(opened).toBe(false);
  expect(replyLines({ from: "orchestrator", text: "text only" })).toHaveLength(1);
});

test("viewer errors cannot repaint a closed page, and terminal image capability is unnecessary", async () => {
  const project = "image-stale-viewer";
  mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, png());
  const record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "replies", messages: [{ from: "worker", text: "Screenshot", attachments: [ref] }] });
  let finish!: () => void, opens = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const term = fakeTerm(100, 28);
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    openMedia: async () => { opens++; await gate; throw new Error("viewer failed"); },
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    term.type("/images\r"); await until(() => term.screen().includes("desktop viewer"));
    expect(opens).toBe(0);
    term.press({ name: "enter" }); await until(() => opens === 1);
    term.press({ name: "escape" }); await until(() => !term.screen().includes("IMAGES"));
    finish(); await Bun.sleep(40);
    expect(term.screen()).not.toContain("viewer failed");
    term.type("/images\r"); await until(() => term.screen().includes("IMAGES"));
    term.press({ name: "enter" }); await until(() => term.screen().includes("viewer failed"));
    await app.refreshSessions(); app.draw(); await Bun.sleep(40);
    expect(opens).toBe(2);
    expect(term.raw()).not.toContain("1337;File=");
  } finally { finish(); app.quit(); await running; }
});

test("Images lists retained recordings beside images and opens video only on Enter", async () => {
  const { saveVerification, verificationPaths } = await import("../core/data/processes/verification-store");
  const { projectIdentity } = await import("../core/data/projects");
  const project = "recording-list", id = crypto.randomUUID();
  mkdirSync(paths.project(project), { recursive: true });
  const record = open(paths.transcript(project, "orchestrator"));
  const ref = await saveImage(project, png());
  await record.append({ type: "replies", messages: [{ from: "worker", text: "Screenshot", attachments: [ref] }] });
  await saveVerification({ project, id, identity: projectIdentity(project), epoch: "fixture", owner: "worker-media", ownerPid: 0,
    source: paths.project(project), backend: "local", state: "closed", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
  const evidence = verificationPaths(project, id).evidence; mkdirSync(evidence, { recursive: true });
  const video = join(evidence, "demo.mp4");
  writeFileSync(video, Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypisom"), 0, 0, 0, 0]));
  const term = fakeTerm(120, 28), opened: string[] = [];
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [],
    openMedia: (project, media) => openDeliveredMedia(project, media, async (file, kind) => { opened.push(kind + ":" + file); }),
    openOrchestrator: async () => ({ say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!() }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    term.type("/images\r"); await until(() => term.screen().includes("Video · demo.mp4"));
    expect(term.screen()).toContain("Screenshot");
    expect(app.status(app.page!)).toEndWith("2 media");
    expect(opened).toEqual([]);
    // Recordings are newer than the delivered screenshot.
    term.press({ name: "enter" }); await until(() => opened.length === 1);
    expect(opened).toEqual(["video:" + video]);
    await until(() => term.screen().includes("Opened demo.mp4"));
    term.type("d"); await until(() => term.screen().includes("Archive 1 images?"));
    term.type("y"); await until(() => term.screen().includes("Archived (1)"));
    expect(app.status(app.page!)).toEndWith("1 media");
    expect(await Bun.file(video).exists()).toBe(true);
    expect(term.raw()).not.toContain("1337;File=");
  } finally { app.quit(); await running; }
});
