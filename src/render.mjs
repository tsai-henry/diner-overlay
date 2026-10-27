// diner-overlay's renderer: a timeline drawn by the overlay page to a transparent video layer or PNG frames.
//
// It serves web/ and the timeline on a free local port, opens the page in headless Chromium
// (playwright-core, with the browsers in ~/.cache/ms-playwright), and for each frame calls
// window.overlaySetTime(T) and captures the page through CDP. Each worker runs one browser on one slice of
// the frames and pipes them into its own ffmpeg; the slices are then joined without re-encoding.
//
//   import { render } from "diner-overlay/render";
//   await render("run.json", "layer.mov", spanTimes(0, 60, 30), { workers: 8 });
//
//   out layer.mov     ProRes 4444 with alpha, for an editor's track
//   out layer.webm    VP9 with alpha
//   out frames/       one PNG per frame (%06d.png)
//
// Speed options:
//   band (default true)    render only the bottom 544 rows and pad back to 1080 (false with a backdrop)
//   gpu "auto"|"on"|"off"  Chrome on the NVIDIA GPU through an EGL vendor file (auto: when libEGL_nvidia exists)
//   workers (8)            browsers, each with its own encoder
//   split (true)           false feeds every worker's frames to one encoder, for comparison
//
// ffmpeg comes from the `ffmpeg` option, then $FFMPEG, then PATH. The command is bin/diner-overlay.mjs.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TIMELINE_FORMAT } from "../web/view.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIRECTORY = path.resolve(HERE, "..", "web");
export const SAMPLE_TIMELINE = path.resolve(HERE, "..", "examples", "sample-timeline.json");
export const WIDTH = 1920;
export const HEIGHT = 1080;
// Everything the overlay draws lies below this row (the pane's top edge). checkRender checks it.
export const BAND_TOP = 536;
const TYPES = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".otf": "font/otf", ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg",
};

// --- times ---

/** One T per output frame, following the cut: frame i of a shot at T_start + (i / fps) * speed. */
export function shotTimes(shots, fps) {
  const times = [];
  for (const [, start, end, speed] of shots.shots) {
    const frames = Math.round((end - start) / speed * fps);
    for (let i = 0; i < frames; i++) times.push(start + (i / fps) * speed);
  }
  return times;
}

export function spanTimes(t0, t1, fps) {
  const frames = Math.round((t1 - t0) * fps);
  return Array.from({ length: frames }, (_, i) => t0 + i / fps);
}

// --- ffmpeg ---

function onPath(names, env, platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
    }
  }
  return null;
}

/**
 * The `ffmpeg` option, then $FFMPEG, then PATH (ffmpeg.exe too on Windows). `system` overrides the platform
 * and the environment, for the tests.
 */
export function findFfmpeg(flag, system = {}) {
  const { platform = process.platform, env = process.env } = system;
  if (flag) return flag;
  if (env.FFMPEG) return env.FFMPEG;
  const found = onPath(platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"], env, platform);
  if (found) return found;
  throw new Error("no ffmpeg: pass --ffmpeg, set $FFMPEG, or put ffmpeg on PATH");
}

export function run(ffmpeg, args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${result.stderr?.toString().trim()}`);
  return result.stdout;
}

/** What out is: a .mov or .webm layer, or a directory of PNGs. */
export function outputKind(out) {
  const ext = path.extname(out).toLowerCase();
  if (ext === ".mov") return "mov";
  if (ext === ".webm") return "webm";
  if (ext) throw new Error(`out ${out}: use a .mov, a .webm or a directory`);
  return "png";
}

const CODECS = {
  mov: ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"],
  webm: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-deadline", "realtime",
    "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0"],
};

/** An ffmpeg that reads PNGs on stdin, pads the band back to full height, and writes one slice. */
function encoder(ffmpeg, { kind, target, fps, band, startNumber }) {
  const pad = band ? ["-vf", `format=rgba,pad=${WIDTH}:${HEIGHT}:0:${BAND_TOP}:color=black@0`] : [];
  const output = kind === "png"
    ? ["-start_number", String(startNumber), "-f", "image2", path.join(target, "%06d.png")]
    : [...CODECS[kind], target];
  const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "pipe:0", ...pad, ...output],
  { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (${target}) exited ${code}: ${stderr.trim()}`))));
  });
  child.stdin.on("error", () => { /* reported by close */ });
  return {
    write: (buffer) => (child.stdin.write(buffer) ? null : new Promise((r) => child.stdin.once("drain", r))),
    close: () => { child.stdin.end(); return done; },
  };
}

// --- the page server ---

/** A timeline object, or a timeline file read and checked. */
export function loadTimeline(source) {
  const timeline = typeof source === "string" ? JSON.parse(fs.readFileSync(source, "utf8")) : source;
  if (timeline?.format !== TIMELINE_FORMAT) throw new Error(`${typeof source === "string" ? source : "timeline"}: not a timeline (${TIMELINE_FORMAT}); see schema/TIMELINE.md`);
  return timeline;
}

/** Serve web/ at /overlay/, the timeline (a Buffer) at /timeline.json and the backdrop, on a free port. */
export function serve(body, backdrop = null) {
  const root = path.resolve(WEB_DIRECTORY);
  const server = http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent((req.url ?? "/").split("?")[0]); } catch { url = "/"; }
    if (url === "/timeline.json") {
      res.writeHead(200, { "content-type": "application/json", "content-length": body.length }).end(body);
      return;
    }
    let file = null;
    if (url === "/backdrop" && backdrop) file = backdrop;
    else if (url.startsWith("/overlay/")) {
      const candidate = path.resolve(root, url.slice("/overlay/".length) || "index.html");
      if (candidate.startsWith(root + path.sep)) file = candidate;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const data = fs.readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-length": data.length });
    res.end(data);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

// --- the GPU ---

const EGL_DIRS = ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib",
  "/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu"];
const GPU_FLAGS = ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"];

/**
 * The browsers' launch options for a GPU mode. Chrome falls back to software drawing on a host whose glvnd has
 * no vendor file for the NVIDIA driver, so this writes one to a temp directory and points only the browsers at it.
 */
export function gpuLaunch(mode, tmp) {
  if (mode === "off") return { mode: "off", args: [], env: process.env };
  const lib = EGL_DIRS.map((dir) => path.join(dir, "libEGL_nvidia.so.0")).find((file) => fs.existsSync(file));
  if (!lib && mode === "auto") return { mode: "off", args: [], env: process.env, note: "no libEGL_nvidia.so.0" };
  const env = { ...process.env };
  if (lib) {
    const vendor = path.join(tmp, "10_nvidia.json");
    fs.writeFileSync(vendor, JSON.stringify({ file_format_version: "1.0.0", ICD: { library_path: "libEGL_nvidia.so.0" } }));
    env.__EGL_VENDOR_LIBRARY_FILENAMES = vendor;
  }
  return { mode: "on", args: GPU_FLAGS, env, note: lib ? undefined : "no libEGL_nvidia.so.0, GPU flags only" };
}

async function webglRenderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "no WebGL";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

// --- rendering ---

/** One browser at the overlay page, ready to capture. */
async function openWorker(chromium, launch, url, { band, transparent }) {
  const browser = await chromium.launch({ args: launch.args, env: launch.env });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: band ? HEIGHT - BAND_TOP : HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  // The band: shift the whole page up so its bottom 544 rows fill the viewport. The page's files stay untouched.
  if (band) await page.addStyleTag({ content: `body { margin-top: -${BAND_TOP}px !important; }` });
  await page.waitForFunction("window.overlayReady !== undefined", null, { timeout: 10_000 });
  await page.evaluate("window.overlayReady");
  if (errors.length) throw new Error(`the overlay page failed: ${errors[0]}`);
  const cdp = await page.context().newCDPSession(page);
  if (transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const worker = { browser, page, errors, retries: 0 };
  worker.capture = async (t) => {
    await page.evaluate((value) => window.overlaySetTime(value), t);
    // Under a heavy load Chrome sometimes answers "Unable to capture screenshot"; a retry gets the frame.
    for (let attempt = 1; ; attempt++) {
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
        return Buffer.from(data, "base64");
      } catch (error) {
        if (attempt >= 4 || !/Unable to capture/.test(String(error))) throw error;
        worker.retries++;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  };
  return worker;
}

/** Contiguous slices of n frames over w workers: [[start, end), ...]. */
export function slices(n, w) {
  const count = Math.max(1, Math.min(w, n));
  return Array.from({ length: count }, (_, k) => [Math.floor((k * n) / count), Math.floor(((k + 1) * n) / count)]);
}

/**
 * Render the times to `out` (.mov, .webm or a PNG directory). `timeline` is a timeline object or a file path.
 * Returns timing numbers.
 * Options: backdrop, band (default true; false with a backdrop), gpu ("auto"), workers (8), split (true), fps,
 * ffmpeg, quiet.
 */
export async function render(timeline, out, times, options = {}) {
  const { chromium } = await import("playwright-core");
  const fps = options.fps ?? 30;
  const backdrop = options.backdrop ?? null;
  const band = backdrop ? false : options.band ?? true;
  const split = options.split ?? true;
  const kind = outputKind(out);
  const ffmpeg = findFfmpeg(options.ffmpeg);
  const log = options.quiet ? () => {} : (line) => console.error(line);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diner-overlay-render-"));
  const launch = gpuLaunch(options.gpu ?? "auto", tmp);
  if (kind === "png") fs.mkdirSync(out, { recursive: true });
  else fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  const server = await serve(Buffer.from(JSON.stringify(loadTimeline(timeline))), backdrop ? path.resolve(backdrop) : null);
  const url = `${server.base}/overlay/?replay=/timeline.json&t=${times[0] ?? 0}${backdrop ? "&backdrop=/backdrop" : ""}`;
  const parts = slices(times.length, options.workers ?? 8);
  const started = performance.now();
  const workers = [];
  let renderer = "";
  let joinS = 0;
  let ready = started;
  try {
    workers.push(...await Promise.all(parts.map(() => openWorker(chromium, launch, url, { band, transparent: !backdrop }))));
    renderer = await webglRenderer(workers[0].page);
    log(`gpu ${launch.mode}${launch.note ? ` (${launch.note})` : ""}: WebGL renderer ${renderer}`);
    if (launch.mode === "on" && /swiftshader|llvmpipe|software/i.test(renderer)) log("gpu: Chrome fell back to software drawing");
    ready = performance.now();

    // A PNG directory without the band needs no ffmpeg: write the captures as they are.
    const direct = kind === "png" && !band;
    const sliceFile = (k) => (kind === "png" ? out : path.join(tmp, `slice_${String(k).padStart(4, "0")}.${kind}`));
    if (split || direct) {
      await Promise.all(parts.map(async ([start, end], k) => {
        const sink = direct ? null : encoder(ffmpeg, { kind, target: sliceFile(k), fps, band, startNumber: start });
        for (let i = start; i < end; i++) {
          const png = await workers[k].capture(times[i]);
          if (direct) fs.writeFileSync(path.join(out, `${String(i).padStart(6, "0")}.png`), png);
          else await sink.write(png);
        }
        if (sink) await sink.close();
      }));
    } else {
      // One encoder: worker k takes frames k, k + w, ... and a writer feeds them to ffmpeg in order.
      const sink = encoder(ffmpeg, { kind, target: kind === "png" ? out : sliceFile(0), fps, band, startNumber: 0 });
      const pending = new Map();
      const waiting = [];
      const ahead = workers.length * 4;
      let next = 0;
      let writing = Promise.resolve();
      const flush = async () => {
        while (pending.has(next)) {
          const png = pending.get(next);
          pending.delete(next++);
          waiting.splice(0).forEach((resolve) => resolve());
          await sink.write(png);
        }
      };
      await Promise.all(workers.map(async (worker, k) => {
        for (let i = k; i < times.length; i += workers.length) {
          while (i >= next + ahead) await new Promise((resolve) => waiting.push(resolve));
          pending.set(i, await worker.capture(times[i]));
          writing = writing.then(flush);
        }
      }));
      await writing;
      await sink.close();
    }
    const rendered = performance.now();
    for (const worker of workers) if (worker.errors.length) throw new Error(`the overlay page failed: ${worker.errors[0]}`);

    if (kind !== "png") {
      const files = split ? parts.map((_, k) => sliceFile(k)) : [sliceFile(0)];
      if (files.length === 1) fs.copyFileSync(files[0], out);
      else {
        const list = path.join(tmp, "slices.txt");
        fs.writeFileSync(list, files.map((f) => `file '${f}'\n`).join(""));
        run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", path.resolve(out)]);
      }
    }
    joinS = (performance.now() - rendered) / 1000;
  } finally {
    await Promise.all(workers.map((w) => w.browser.close().catch(() => {})));
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const total = (performance.now() - started) / 1000;
  const renderS = (performance.now() - ready) / 1000 - joinS;
  const round = (x, d = 2) => Number(x.toFixed(d));
  return {
    frames: times.length, workers: parts.length, retries: workers.reduce((sum, w) => sum + w.retries, 0), band, gpu: launch.mode, renderer, split, output: kind,
    startup_s: round((ready - started) / 1000), render_s: round(renderS), join_s: round(joinS), total_s: round(total),
    frames_per_s: round(times.length / total, 1),
  };
}

/** The layer over a video, from videoStart, as H.264 at the layer's rate. */
export function composite(layer, video, outVideo, fps, videoStart, ffmpegFlag) {
  const ffmpeg = findFfmpeg(ffmpegFlag);
  fs.mkdirSync(path.dirname(path.resolve(outVideo)), { recursive: true });
  const kind = outputKind(layer);
  const layerInput = kind === "png" ? ["-framerate", String(fps), "-i", path.join(layer, "%06d.png")]
    : [...(kind === "webm" ? ["-c:v", "libvpx-vp9"] : []), "-i", layer];
  run(ffmpeg, [
    "-ss", videoStart.toFixed(3), "-i", video, ...layerInput,
    "-filter_complex",
    `[0:v]fps=${fps},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1[base];` +
      "[base][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]",
    "-map", "[v]", "-map", "0:a?", "-shortest", "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-c:a", "aac", outVideo,
  ]);
}

// --- checks ---

/** Decode a PNG, a PNG directory's frames or a layer into RGBA frames (Buffers of WIDTH * HEIGHT * 4). */
export function decode(ffmpeg, input, kind) {
  const pre = kind === "webm" ? ["-c:v", "libvpx-vp9"] : [];
  const raw = run(ffmpeg, [...pre, "-i", input, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const size = WIDTH * HEIGHT * 4;
  if (raw.length % size) throw new Error(`${input}: ${raw.length} bytes is not a whole number of ${WIDTH}x${HEIGHT} frames`);
  return Array.from({ length: raw.length / size }, (_, i) => raw.subarray(i * size, (i + 1) * size));
}

/** Alpha facts of one RGBA frame. */
export function alphaFacts(frame) {
  let low = 255, high = 0, above = 0;
  for (let i = 3; i < frame.length; i += 4) {
    const a = frame[i];
    if (a < low) low = a;
    if (a > high) high = a;
    if (a && (i >> 2) < BAND_TOP * WIDTH) above++;
  }
  return { low, high, above, middle: frame[(300 * WIDTH + 960) * 4 + 3] };
}

export function maxDiff(a, b) {
  let most = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > most) most = d; }
  return most;
}

/**
 * Render `moments` of a timeline every way the renderer can and check the results: full-height frames with
 * clear and opaque pixels and nothing above the band, band frames equal to full height, and .mov and .webm
 * layers with every frame, in order, with alpha. Returns the failures, an empty list when all is well.
 */
export async function checkRender(timeline, moments, { ffmpeg: ffmpegFlag = null, log = console.log } = {}) {
  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const ffmpeg = findFfmpeg(ffmpegFlag);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diner-overlay-check-"));
  try {
    // Full height: the reference frames, and the band check.
    const full = path.join(tmp, "full");
    const fullStats = await render(timeline, full, moments, { band: false, workers: 1, quiet: true, ffmpeg });
    log("full height:", JSON.stringify(fullStats));
    const reference = moments.map((_, i) => decode(ffmpeg, path.join(full, `${String(i).padStart(6, "0")}.png`), "png")[0]);
    reference.forEach((frame, i) => {
      const facts = alphaFacts(frame);
      check(facts.low === 0 && facts.high === 255, `frame ${i}: alpha ${facts.low}..${facts.high}, wanted fully clear and fully opaque pixels`);
      check(facts.middle === 0, `frame ${i}: the middle of the frame is not transparent`);
      check(facts.above === 0, `frame ${i}: ${facts.above} pixels drawn above row ${BAND_TOP}, which the band would cut off`);
    });

    // The band, over two workers, padded back: the same pixels as full height.
    const banded = path.join(tmp, "band");
    const bandStats = await render(timeline, banded, moments, { workers: 2, quiet: true, gpu: fullStats.gpu, ffmpeg });
    log("band:", JSON.stringify(bandStats));
    moments.forEach((_, i) => {
      const frame = decode(ffmpeg, path.join(banded, `${String(i).padStart(6, "0")}.png`), "png")[0];
      const diff = maxDiff(frame, reference[i]);
      check(diff <= 2, `frame ${i}: the band differs from full height by up to ${diff}`);
    });

    // The layers: every frame present, in order, with alpha.
    for (const [kind, split] of [["mov", true], ["webm", true], ["mov", false]]) {
      const layer = path.join(tmp, `layer_${split ? "split" : "one"}.${kind}`);
      const stats = await render(timeline, layer, moments, { workers: 2, split, quiet: true, gpu: fullStats.gpu, ffmpeg });
      log(`${kind}:`, JSON.stringify(stats));
      const frames = decode(ffmpeg, layer, kind);
      check(frames.length === moments.length, `${kind}: ${frames.length} frames, wanted ${moments.length}`);
      frames.forEach((frame, i) => {
        const facts = alphaFacts(frame);
        check(facts.high >= 250 && facts.middle === 0 && facts.above === 0, `${kind} frame ${i}: alpha lost (${JSON.stringify(facts)})`);
        const diff = maxDiff(frame, reference[i]);
        check(diff <= (kind === "mov" ? 40 : 160), `${kind} frame ${i}: differs from its PNG by up to ${diff}, frames out of order?`);
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return failures;
}
