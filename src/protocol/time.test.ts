import { expect, test } from "bun:test";

test("dates use the local timezone, daylight saving offset, and retain date-only values", async () => {
  const module = new URL("./time.ts", import.meta.url).href;
  const script = `import { formatDateTime } from ${JSON.stringify(module)};
    console.log(JSON.stringify([
      formatDateTime("2026-11-09T20:20:00Z"),
      formatDateTime("2026-08-01T02:05:00Z"),
      formatDateTime("2026-01-01"),
      formatDateTime("invalid")
    ]));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, TZ: "America/New_York" }, stdout: "pipe", stderr: "pipe",
  });
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(text)).toEqual([
    "Nov 9, 2026, 3:20 PM EST",
    "Jul 31, 2026, 10:05 PM EDT",
    "Jan 1, 2026",
    "Unknown date",
  ]);
});
