import { expect, test } from "bun:test";
import { clipboardCommand, MAC_CLIPBOARD_SCRIPT, readClipboardImage, type ClipboardAdapter } from "./clipboard";
import { png } from "./test/image-fixture";
function adapter(overrides: Partial<ClipboardAdapter> = {}): ClipboardAdapter {
  return { platform: "linux", env: {}, which: () => null, run: async () => { throw new Error("unexpected clipboard access"); }, ...overrides };
}
test("clipboard mechanisms are on-demand, unavailable/headless/remote errors actionable; no dependency installation", async () => {
  await expect(readClipboardImage(adapter())).rejects.toThrow("wl-paste");
  await expect(readClipboardImage(adapter({ platform: "darwin", env: { SSH_TTY: "/dev/pts/1" } }))).rejects.toThrow("SSH");
  await expect(readClipboardImage(adapter({ platform: "win32" }))).rejects.toThrow("macOS or Linux");
});
test.each([true, false])("Linux existing tool selection (Wayland=%j), types checked before bounded binary read", async wl => {
  const calls: string[][] = [];
  const image = await readClipboardImage(adapter({ env: wl ? { WAYLAND_DISPLAY: "fixture" } : { DISPLAY: "fixture" }, which: name => `/fixture/${name}`, run: async (args, limit) => {
    calls.push(args); expect(limit).toBeGreaterThan(0);
    return calls.length === 1 ? Buffer.from("text/plain\nimage/png\n") : png();
  } }));
  expect(image.bytes).toEqual(png()); expect(calls).toHaveLength(2);
  expect(calls[0]![0]).toBe(`/fixture/${wl ? "wl-paste" : "xclip"}`);
  expect(calls[1]).toContain("image/png");
});
test.each(["", "text/plain\n", "image/jpeg\n"])("clipboard unsupported/text/empty %j leaves text paste to terminal", async types => {
  let calls = 0;
  await expect(readClipboardImage(adapter({ env: { WAYLAND_DISPLAY: "fixture" }, which: () => "/fixture/wl-paste", run: async () => { calls++; return Buffer.from(types); } }))).rejects.toThrow(types.includes("image") ? "Unsupported" : "no image");
  expect(calls).toBe(1);
});
test("macOS uses embedded JXA system executable only, validates actual output; errors propagate", async () => {
  const bytes = await readClipboardImage(adapter({ platform: "darwin", run: async args => {
    expect(args.slice(0, 3)).toEqual(["/usr/bin/osascript", "-l", "JavaScript"]);
    expect(args.at(-1)).toBe(MAC_CLIPBOARD_SCRIPT);
    expect(MAC_CLIPBOARD_SCRIPT).not.toContain("Application(");
    return Buffer.from(png().toString("base64") + "\n");
  } }));
  expect(bytes.bytes).toEqual(png());
  await expect(readClipboardImage(adapter({ platform: "darwin", run: async () => Buffer.from("not an image") }))).rejects.toThrow("invalid image");
  await expect(readClipboardImage(adapter({ platform: "darwin", run: async () => { throw new Error("fixture access denied"); } }))).rejects.toThrow("access denied");
});
// Execute AppKit/Foundation bridging against an isolated in-memory fake object,
// NEVER NSPasteboard.generalPasteboard or the user's live clipboard.
test.skipIf(process.platform !== "darwin")("system JXA PNG and native TIFF/JPEG conversion fixtures (no live pasteboard)", async () => {
  for (const type of ["public.png", "public.tiff", "public.jpeg"]) {
    const data = `$.NSData.alloc.initWithBase64EncodedStringOptions($('${png().toString("base64")}'), 0)`;
    const fixture = `({ changeCount: 1, types: $(['${type}']), dataForType: function() { return ${type === "public.png" ? data : `$.NSBitmapImageRep.imageRepWithData(${data})${type === "public.tiff" ? ".TIFFRepresentation" : ".representationUsingTypeProperties(3, $({}))"}`}; } })`;
    const script = MAC_CLIPBOARD_SCRIPT.replace("$.NSPasteboard.generalPasteboard", fixture);
    expect(script).not.toContain("NSPasteboard");
    const result = await clipboardCommand(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], 10000);
    expect(Buffer.from(result).toString().trim().length).toBeGreaterThan(0);
    // Conversion can normalize bytes; both outputs must be decodable PNG.
    const image = await readClipboardImage(adapter({ platform: "darwin", run: async () => result }));
    expect(image.mime).toBe("image/png");
  }
});
