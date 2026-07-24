import { createServer } from "node:http";

// Placeholder health-check server. The real Fastify API (REST, SSE, SPA
// static serving) lands in T12 — see docs/pm-task-breakdown.md.
const port = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`pm server listening on :${port}`);
});
