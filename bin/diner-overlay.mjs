#!/usr/bin/env node
// diner-overlay's command.
//
//   diner-overlay render --timeline run.json --out layer.mov (--t0 S --t1 S | --times 1,2,3 | --shots shots.json)
//                        [--fps 30] [--workers 8] [--gpu auto|on|off] [--band on|off] [--split on|off]
//                        [--backdrop image] [--ffmpeg path] [--composite video --out-video out.mp4 [--video-start S]]
//   diner-overlay preview --timeline run.json [--port 8080]    the page with Play and a slider, in a browser
//   diner-overlay selftest                                     render the sample timeline and check the frames

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { SAMPLE_TIMELINE, checkRender, composite, loadTimeline, outputKind, render, serve, shotTimes, spanTimes } from "../src/render.mjs";

const USAGE = `usage: diner-overlay render --timeline run.json --out layer.mov|layer.webm|frames/
         (--t0 S --t1 S | --shots shots.json | --times 1,2,3) [--fps 30] [--backdrop image]
         [--band on|off] [--gpu auto|on|off] [--workers 8] [--split on|off] [--ffmpeg path]
         [--composite video --out-video out.mp4 [--video-start S]]
       diner-overlay preview --timeline run.json [--port 8080]
       diner-overlay selftest [--ffmpeg path]`;

const OPTIONS = {
  timeline: { type: "string" }, out: { type: "string" },
  t0: { type: "string" }, t1: { type: "string" }, shots: { type: "string" }, times: { type: "string" },
  fps: { type: "string", default: "30" }, backdrop: { type: "string" },
  composite: { type: "string" }, "video-start": { type: "string", default: "0" }, "out-video": { type: "string" },
  band: { type: "string", default: "on" }, gpu: { type: "string", default: "auto" },
  workers: { type: "string", default: "8" }, split: { type: "string", default: "on" },
  ffmpeg: { type: "string" }, port: { type: "string", default: "8080" }, help: { type: "boolean", short: "h" },
};

// The frame times a render asks for: a span, a list, or a highlights cut's shot list.
export function timesFrom(a, fps) {
  if (a.shots) return shotTimes(JSON.parse(fs.readFileSync(a.shots, "utf8")), fps);
  if (a.times) return a.times.split(",").map(Number);
  if (a.t0 !== undefined && a.t1 !== undefined) return spanTimes(Number(a.t0), Number(a.t1), fps);
  return null;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values: a } = parseArgs({ args: rest, options: OPTIONS });
  const fail = (message) => { console.error(`${message}\n${USAGE}`); return 2; };
  if (!command || a.help || command === "help") { console.log(USAGE); return command ? 0 : 2; }
  if (command === "selftest") {
    const failures = await checkRender(SAMPLE_TIMELINE, [30, 50, 58], { ffmpeg: a.ffmpeg });
    for (const failure of failures) console.log(`FAIL ${failure}`);
    console.log("selftest:", failures.length ? "FAILED" : "ok");
    return failures.length ? 1 : 0;
  }
  if (command === "preview") {
    if (!a.timeline) return fail("--timeline is required");
    const timeline = loadTimeline(a.timeline);
    const server = await serve(Buffer.from(JSON.stringify(timeline)));
    console.log(`open ${server.base}/overlay/?replay=/timeline.json&play=1&t=0 (Ctrl-C to stop)`);
    return new Promise(() => {});
  }
  if (command !== "render") return fail(`unknown command ${command}`);
  if (!a.timeline || !a.out) return fail("--timeline and --out are required");
  for (const [flag, allowed] of [["band", ["on", "off"]], ["gpu", ["auto", "on", "off"]], ["split", ["on", "off"]]]) {
    if (!allowed.includes(a[flag])) return fail(`--${flag} ${a[flag]}: use ${allowed.join(", ")}`);
  }
  const fps = Number(a.fps);
  const times = timesFrom(a, fps);
  if (!times) return fail("give --t0 and --t1, --shots or --times");
  if (a.composite && !a["out-video"]) return fail("--composite needs --out-video");
  outputKind(a.out);
  const stats = await render(a.timeline, a.out, times, {
    fps, backdrop: a.backdrop, band: a.band === "on", gpu: a.gpu, workers: Number(a.workers), split: a.split === "on", ffmpeg: a.ffmpeg,
  });
  if (outputKind(a.out) === "png") fs.writeFileSync(path.join(a.out, "frames.json"), JSON.stringify({ times, fps, ...stats }));
  console.log(`${a.out}: ${JSON.stringify(stats)}`);
  if (a.composite) {
    composite(a.out, a.composite, a["out-video"], fps, Number(a["video-start"]), a.ffmpeg);
    console.log(`${a["out-video"]}: composited over ${a.composite} from ${Number(a["video-start"]).toFixed(2)} s`);
  }
  return 0;
}

main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code; }, (error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
