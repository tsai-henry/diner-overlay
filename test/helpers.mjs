// Shared test helpers: the sample timeline, and a minimal app with Express's get/use meaning.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sample = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/sample-timeline.json"), "utf8"));
export const BROWSER = process.env.DINER_OVERLAY_BROWSER === "1";
export const SKIP_BROWSER = !BROWSER && "set DINER_OVERLAY_BROWSER=1 to run the Chromium checks";

// get(path) matches the path exactly; use(prefix) matches the prefix and strips it from req.url, keeping
// req.originalUrl, as Express does.
export function tinyApp() {
  const routes = [];
  const app = {
    get: (route, handler) => routes.push({ kind: "get", route, handler }),
    use: (prefix, handler) => routes.push({ kind: "use", route: prefix, handler }),
  };
  const server = http.createServer((req, res) => {
    const [pathname] = req.url.split("?");
    req.originalUrl = req.url;
    const queue = routes.filter((r) => (r.kind === "get" ? pathname === r.route && req.method === "GET"
      : pathname === r.route || pathname.startsWith(`${r.route}/`)));
    const next = () => {
      const route = queue.shift();
      if (!route) return res.writeHead(404).end("not found");
      if (route.kind === "use") req.url = `/${req.originalUrl.slice(route.route.length).replace(/^\//, "")}`;
      return route.handler(req, res, next);
    };
    next();
  });
  return { app, listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))), close: () => server.close() };
}
