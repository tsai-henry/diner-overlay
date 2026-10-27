// The renderer: its small parts always, and a full render of the sample with DINER_OVERLAY_BROWSER=1.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SAMPLE_TIMELINE, checkRender, findFfmpeg, loadTimeline, outputKind, shotTimes, slices, spanTimes } from "../src/render.mjs";
import { SKIP_BROWSER } from "./helpers.mjs";

test("frame times, slices and output kinds", () => {
  const times = shotTimes({ shots: [["a", 10.0, 11.0, 2.0], ["b", 20.0, 20.5, 0.5]] }, 30);
  assert.equal(times.length, 45);
  assert.equal(times[15], 20.0);
  assert.equal(spanTimes(13, 137, 30).length, 3720);
  assert.deepEqual(slices(10, 3), [[0, 3], [3, 6], [6, 10]]);
  assert.equal(slices(2, 8).length, 2);
  assert.deepEqual(["a/b.mov", "a/b.webm", "frames"].map(outputKind), ["mov", "webm", "png"]);
  assert.throws(() => outputKind("x.mp4"), /use a \.mov/);
});

test("ffmpeg comes from the flag, then $FFMPEG, then PATH", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diner-overlay-ffmpeg-"));
  try {
    const exe = path.join(tmp, "ffmpeg.exe");
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    assert.equal(findFfmpeg("/y/ffmpeg", { env: { FFMPEG: "/x/ffmpeg" } }), "/y/ffmpeg");
    assert.equal(findFfmpeg(null, { env: { FFMPEG: "/x/ffmpeg" } }), "/x/ffmpeg");
    assert.equal(findFfmpeg(null, { platform: "win32", env: { Path: `C:\\nowhere;${tmp}` } }), exe);
    assert.throws(() => findFfmpeg(null, { platform: "linux", env: { PATH: tmp } }), /no ffmpeg/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadTimeline refuses a file that is not a timeline", () => {
  assert.equal(loadTimeline(SAMPLE_TIMELINE).format, "overlay-timeline/1");
  assert.throws(() => loadTimeline({ calls: [] }), /not a timeline/);
});

test("the sample renders to PNGs, a band, .mov and .webm layers, all with alpha and nothing above the band",
  { skip: SKIP_BROWSER, timeout: 180_000 }, async () => {
    const failures = await checkRender(SAMPLE_TIMELINE, [30, 50, 58], { log: () => {} });
    assert.deepEqual(failures, []);
  });
