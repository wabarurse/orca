/** Compiled-only fixture: no real pasteboard/provider access, no source helpers at runtime. */
import { mkdirSync } from "node:fs";
import { paths } from "../config";
import { clipboardCommand, MAC_CLIPBOARD_SCRIPT, readClipboardImage } from "../clipboard";
import { imageContent, materializeImages, saveImage } from "../images";
import { claudeMessages } from "../providers/anthropic";
import { toResponses } from "../providers/openai";
import { png } from "./image-fixture";
export async function installedImages() {
  const fixture = png();
  const script = MAC_CLIPBOARD_SCRIPT.replace("$.NSPasteboard.generalPasteboard",
    `({ changeCount: 1, types: $(['public.png']), dataForType: function() { return $.NSData.alloc.initWithBase64EncodedStringOptions($('${fixture.toString("base64")}'), 0); } })`);
  if (script.includes("NSPasteboard")) throw new Error("live clipboard forbidden");
  const image = await readClipboardImage({ platform: process.platform, env: process.platform === "linux" ? { WAYLAND_DISPLAY: "fixture" } : {}, which: () => "/fixture/wl-paste",
    run: async args => process.platform === "darwin"
      ? clipboardCommand(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], 10000)
      : args.includes("--list-types") ? Buffer.from("image/png") : fixture });
  const project = "compiled-image-fixture"; mkdirSync(paths.project(project), { recursive: true });
  const ref = await saveImage(project, image.bytes, image.mime);
  const messages = await materializeImages(project, [{ role: "user", content: imageContent("compiled pixels", [ref]) }]);
  const claude = claudeMessages(messages), codex = toResponses(messages);
  const wanted = fixture.toString("base64");
  if (!JSON.stringify(claude).includes(wanted) || !JSON.stringify(codex).includes(`data:image/png;base64,${wanted}`)) throw new Error("compiled image content missing");
  return { images: 1, claude: true, codex: true, nativeFixture: process.platform === "darwin" };
}
