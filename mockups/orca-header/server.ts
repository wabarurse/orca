// Throwaway local design gallery. Delete after the user's pick.
const root = import.meta.dir;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 4187,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return Response.redirect("/mockup-pick");
    if (path === "/mockup-pick" || path === "/mockup-pick/") return new Response(Bun.file(`${root}/index.html`));
    if (path === "/animation.js") return new Response(Bun.file(`${root}/animation.js`), { headers: { "content-type": "text/javascript" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`orca previews: ${server.url}mockup-pick`);
