import { join } from "node:path";

export function galleryResponse(path: string): Response | undefined {
  if (path === "/mockup-pick" || path === "/mockup-pick/") return new Response(Bun.file(join(import.meta.dir, "index.html")));
  const files: Record<string, string> = {
    "/mockup-pick/styles.css": "styles.css",
    "/mockup-pick/variants.js": "variants.js",
    "/mockup-pick/shared.js": "shared.js",
  };
  if (files[path]) return new Response(Bun.file(join(import.meta.dir, files[path])));
}

if (import.meta.main) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 4187, fetch: request => galleryResponse(new URL(request.url).pathname) ?? new Response("not found", { status: 404 }) });
  console.log(`http://127.0.0.1:${server.port}/mockup-pick`);
}
