import { expect, test } from "bun:test";
import { clipboardCommand, MAC_CLIPBOARD_SCRIPT, readClipboardImage, type ClipboardAdapter } from "./clipboard";
import { png } from "./test/image-fixture";
function adapter(overrides: Partial<ClipboardAdapter> = {}): ClipboardAdapter {
  return { platform: "linux", env: {}, which: () => null, run: async () => { throw new Error("unexpected clipboard access"); }, ...overrides };
}
test("clipboard mechanisms are on-demand, unavailable/headless/remote errors actionable; no dependency installation", async () => {
  await expect(readClipboardImage(adapter())).rejects.toThrow("wl-paste");
  await expect(readClipboardImage(adapter({ platform: "darwin", env: { SSH_TTY: "/dev/pts/1" } }))).rejects.toThrow("ssh");
  await expect(readClipboardImage(adapter({ platform: "win32" }))).rejects.toThrow("macos or linux");
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
  await expect(readClipboardImage(adapter({ env: { WAYLAND_DISPLAY: "fixture" }, which: () => "/fixture/wl-paste", run: async () => { calls++; return Buffer.from(types); } }))).rejects.toThrow(types.includes("image") ? "unsupported" : "no image");
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

test('explicit text copy uses fixed argv and stdin; platform failures never fall back to OSC or shell', async () => {
  const { writeClipboardText } = await import('./clipboard');
  const calls: [string[], string][] = [];
  const text = '$(touch /tmp/SHOULD-NOT-EXIST)\n`echo nope` 界';
  const base = { platform: 'darwin', env: {}, which: (name: string) => `/fixture/${name}`, run: async (argv: string[], input: string) => { calls.push([argv, input]); } };
  await writeClipboardText(text, base);
  expect(calls).toEqual([[['/usr/bin/pbcopy'], text]]);
  await writeClipboardText(text, { ...base, platform: 'linux', env: { WAYLAND_DISPLAY: 'test' } });
  expect(calls[1]).toEqual([['/fixture/wl-copy', '--type', 'text/plain;charset=utf-8'], text]);
  await writeClipboardText(text, { ...base, platform: 'linux', env: { DISPLAY: 'test' } });
  expect(calls[2]).toEqual([['/fixture/xclip', '-selection', 'clipboard', '-in'], text]);
  for (const adapter of [{ ...base, env: { SSH_TTY: 'test' } }, { ...base, platform: 'linux' }, { ...base, platform: 'win32' }]) {
    await expect(writeClipboardText(text, adapter)).rejects.toThrow();
  }
  await expect(writeClipboardText('x'.repeat(4 * 1024 * 1024 + 1), base)).rejects.toThrow('limit');
  expect(calls).toHaveLength(3);
  await expect(writeClipboardText(text, { ...base, run: async () => { throw new Error('fixture service failed'); } })).rejects.toThrow('fixture service failed');
});

test('text writer subprocess delivers Unicode and shell metacharacters only on stdin, and reports failure', async () => {
  const { clipboardWriteCommand } = await import('./clipboard');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'parallels-copy-'));
  const file = join(dir, 'copied');
  const text = '界é\n$(echo injected); `echo nope` "quotes"';
  try {
    await clipboardWriteCommand([process.execPath, '-e', 'await Bun.write(process.argv[1], await Bun.stdin.text())', file], text);
    expect(readFileSync(file, 'utf8')).toBe(text);
    await expect(clipboardWriteCommand([process.execPath, '-e', 'process.exit(1)'], text)).rejects.toThrow('failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const onTerm of ['ignore', 'exit-zero']) test(`text writer deadline rejects and reaps child that handles TERM: ${onTerm}`, async () => {
  const { clipboardWriteCommand } = await import('./clipboard');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'parallels-copy-timeout-'));
  const ready = join(dir, 'ready'), signal = join(dir, 'signal');
  let pid: number | undefined;
  try {
    const code = `
      process.on('SIGTERM', () => {
        require('node:fs').writeFileSync(process.argv[2], 'TERM');
        ${onTerm === 'exit-zero' ? 'process.exit(0);' : ''}
      });
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 100);
      // Safety exit also reproduces a TERM-ignoring child returning zero late.
      setTimeout(() => process.exit(0), 3000);
    `;
    const started = Date.now();
    await expect(clipboardWriteCommand([process.execPath, '-e', code, ready, signal], 'fixture', 500)).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2500);
    pid = Number(readFileSync(ready, 'utf8'));
    expect(readFileSync(signal, 'utf8')).toBe('TERM');
    // Rejection is after reaping, not a Promise.race that leaves a child alive.
    expect(() => process.kill(pid!, 0)).toThrow();
    pid = undefined;
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});
