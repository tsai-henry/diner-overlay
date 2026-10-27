// diner-overlay's server side: the page, the live timeline and its pushed stream, on an Express app.
//
//   const overlay = mountOverlay(app, { getTimeline, subscribe });
//   ...
//   overlay.close();   // on shutdown: ends the open streams
//
// It serves
//   GET <basePath>/          the page (web/), with view.mjs and the fonts
//   GET <apiBase>/state      the current timeline once
//   GET <apiBase>/stream     an event stream: the timeline on every change that alters it, at most every
//                            `everyMs`, and a `beat` event every `heartbeatMs`, which the page needs to tell
//                            a quiet stream from a lost one
//
// getTimeline() returns the current timeline v1 (schema/TIMELINE.md). subscribe(fn) calls fn whenever
// the application's state may have changed, and returns a function that stops it. Mount it before any
// catch-all route. `app` is Express 4 or 5, or anything with get(path, handler) and use(path, handler)
// that means the same.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
export const HEARTBEAT_MS = 1_000;
export const STREAM_EVERY_MS = 50;
// A reader whose socket holds this much unsent data is behind, and is dropped after BEHIND_MS of it.
const BACKLOG_MAX = 1 << 20;
const BEHIND_MS = 30_000;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".otf": "font/otf", ".txt": "text/plain; charset=utf-8",
};

// What a timeline says apart from the moment it was built. A running timer moves on by itself, so only
// its offset from the axis counts; a correction to it changes the key.
export function timelineKey(timeline) {
  const timer = timeline.timer;
  const timerKey = timer ? { running: timer.running, base: Math.round((timer.running ? timer.value - timer.at : timer.value) * 100) } : null;
  return JSON.stringify({ ...timeline, clock: null, timer: timerKey });
}

export const heartbeat = (now = Date.now()) => `event: beat\ndata: {"t":${now / 1000}}\n\n`;

// An event stream whose every message is the whole timeline. A reader that falls behind skips messages
// and gets the newest with its next beat once it has caught up; one that stays behind is dropped.
export class TimelineStream {
  constructor({ snapshot, now = Date.now, heartbeatMs = HEARTBEAT_MS }) {
    this.snapshot = snapshot;
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.clients = new Set();
  }

  get size() {
    return this.clients.size;
  }

  add(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const client = { res, behindSince: null, stale: false, timer: null };
    this.clients.add(client);
    this.write(client, this.message());
    client.timer = setInterval(() => this.tick(client), this.heartbeatMs);
    client.timer.unref?.();
    req.on("close", () => this.drop(client));
    return client;
  }

  message() {
    return `data: ${JSON.stringify(this.snapshot())}\n\n`;
  }

  verdict(client) {
    if ((Number(client.res.writableLength) || 0) < BACKLOG_MAX) {
      client.behindSince = null;
      return "write";
    }
    client.behindSince ??= this.now();
    return this.now() - client.behindSince > BEHIND_MS ? "drop" : "skip";
  }

  broadcast() {
    if (!this.clients.size) return;
    const event = this.message();
    for (const client of [...this.clients]) {
      const verdict = this.verdict(client);
      if (verdict === "drop") this.drop(client, { destroy: true });
      else if (verdict === "skip") client.stale = true;
      else {
        client.stale = false;
        this.write(client, event);
      }
    }
  }

  tick(client) {
    const verdict = this.verdict(client);
    if (verdict === "drop") return this.drop(client, { destroy: true });
    if (verdict === "skip") return undefined;
    if (client.stale) {
      client.stale = false;
      return this.write(client, this.message());
    }
    return this.write(client, heartbeat(this.now()));
  }

  write(client, text) {
    try {
      client.res.write(text);
    } catch {
      this.drop(client);
    }
  }

  close() {
    for (const client of [...this.clients]) {
      this.drop(client);
      try {
        client.res.end();
      } catch {
        // The socket is already gone.
      }
    }
  }

  drop(client, { destroy = false } = {}) {
    clearInterval(client.timer);
    if (!this.clients.delete(client)) return;
    try {
      if (destroy) client.res.destroy?.();
    } catch {
      // The socket is already gone.
    }
  }
}

// The page's files, from web/, with no directory listing and nothing outside web/.
export function staticPage(directory = WEB_DIRECTORY) {
  const root = path.resolve(directory);
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next?.();
    // /overlay must become /overlay/, or the page's relative imports resolve one level up.
    const [original, query] = String(req.originalUrl ?? "").split("?");
    if (original && !original.endsWith("/") && (req.url === "/" || req.url === "" || req.url?.startsWith("/?"))) {
      res.writeHead(301, { location: `${original}/${query ? `?${query}` : ""}` }).end();
      return undefined;
    }
    let name;
    try {
      name = decodeURIComponent(String(req.url || "/").split("?")[0]);
    } catch {
      name = "/";
    }
    if (name === "" || name.endsWith("/")) name += "index.html";
    const file = path.resolve(root, `.${name}`);
    if (!file.startsWith(root + path.sep)) return next?.();
    let body;
    try {
      body = await readFile(file);
    } catch {
      return next ? next() : res.writeHead(404).end();
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return undefined;
  };
}

export function mountOverlay(app, {
  getTimeline, subscribe = null, basePath = "/overlay", apiBase = "/api/overlay",
  now = Date.now, heartbeatMs = HEARTBEAT_MS, everyMs = STREAM_EVERY_MS, onError = (error) => console.error(`diner-overlay: ${error.message}`),
} = {}) {
  if (typeof getTimeline !== "function") throw new TypeError("mountOverlay needs getTimeline()");
  const stream = new TimelineStream({ snapshot: getTimeline, now, heartbeatMs });
  let lastKey = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (!stream.size) return;
    try {
      const key = timelineKey(getTimeline());
      if (key === lastKey) return;
      lastKey = key;
      stream.broadcast();
    } catch (error) {
      onError(error);
    }
  };
  const changed = () => {
    if (timer || !stream.size) return;
    timer = setTimeout(flush, everyMs);
    timer.unref?.();
  };
  const unsubscribe = subscribe ? subscribe(changed) : null;
  app.get(`${apiBase}/stream`, (req, res) => {
    try {
      stream.add(req, res);
      // The new reader has the current timeline. A pending push still goes out to the others.
      if (!timer) lastKey = timelineKey(getTimeline());
    } catch (error) {
      onError(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  app.get(`${apiBase}/state`, (_req, res) => {
    try {
      const body = JSON.stringify(getTimeline());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch (error) {
      onError(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  app.use(basePath, staticPage());
  return {
    stream,
    close() {
      clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
      stream.close();
    },
  };
}
