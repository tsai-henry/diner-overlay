// viewAt and its parts, on the hand-written sample timeline (examples/sample-timeline.json).
import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_FILL_CAP, MOTION, TIMELINE_FORMAT, callsAt, clockText, easeOut, fillFraction, liveTime, outageAt, presenceAt,
  secondsText, timerAt, viewAt } from "../web/view.mjs";
import { sample } from "./helpers.mjs";

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} is not ${b}`);
const fields = (row) => row.fields.map((f) => `${f.key} ${f.value}${f.warn ? " !" : ""}`);

test("the sample is a timeline v1", () => {
  assert.equal(sample().format, TIMELINE_FORMAT);
});

test("seconds, the clock and the fill read as the design writes them", () => {
  assert.equal(secondsText(1.44), "1.4 s");
  assert.equal(secondsText(9.96), "10 s");
  assert.equal(clockText(86.4), "T+ 01:26");
  assert.equal(clockText(-3), "T+ 00:00");
  assert.equal(fillFraction(5, 10), 0.5);
  assert.equal(fillFraction(20, 10, { capped: true }), LIVE_FILL_CAP);
  assert.equal(fillFraction(5, 0), 0);
});

test("the bar at T: done, current and pending segments, the line, and the end", () => {
  const timeline = sample();
  const view = viewAt(timeline, 30);
  assert.equal(view.clock, "T+ 00:30");
  assert.equal(view.line, "SUBTASK #3: PICK UP THE BLUE MUG");
  assert.deepEqual(view.segments.map((s) => s.state), ["done", "done", "current", "pending", "pending"]);
  assert.deepEqual(view.segments.map((s) => s.time), ["12.5 s", "8.5 s", "9.0 s", "", ""]);
  near(view.segments[2].fill, 9 / 17.5, "the current fill");
  const after = viewAt(timeline, 64.5);
  assert.equal(after.line, "ALL 5 SUBTASKS DONE");
  assert.equal(after.segments[4].warn, true);
  assert.equal(viewAt(timeline, 300).clock, "T+ 01:04");
});

test("the calls at T: the newest large with two stages, the rest below, hidden and dropped calls left out", () => {
  const calls = sample().calls;
  const at30 = callsAt(calls, 30);
  assert.equal(at30.top.name, "pick_up");
  assert.equal(at30.top.running, true);
  assert.deepEqual(fields(at30.top), ["ITEM blue mug"]);
  assert.deepEqual(at30.top.stages.map((s) => [s.name, s.running, s.took]), [["reach", true, ""], ["approach", false, "4.5 s"]]);
  assert.deepEqual(at30.history.map((r) => r.name), ["look_for", "drive_to"]);
  assert.equal(at30.count, 7);
  assert.deepEqual(fields(callsAt(calls, 15.5).top), ["ITEM blue mug", "SEEN no !"]);
  assert.equal(callsAt(calls, 17).history.filter((r) => r.name === "look_for").length, 0);
  assert.deepEqual(fields(callsAt(calls, 40).history[0]), ["ITEM blue mug", "RESULT HOLDING · 4 stages"]);
});

test("the live timer piece moves the clock while it runs and holds it while paused", () => {
  const live = { ...sample(), clock: { t: 1000 }, start: 900, end: null, timer: { at: 1000, value: 30, running: true } };
  assert.equal(viewAt(live, liveTime(live, 2)).clock, "T+ 00:32");
  assert.equal(timerAt({ ...live, timer: { ...live.timer, running: false } }, 1010), 30);
});

test("the motions: intro, outro, a new call and a done flash", () => {
  const timeline = sample();
  assert.equal(viewAt(timeline, 0).hidden, true);
  near(viewAt(timeline, 0.3).pane.x, -MOTION.paneTravelPx * (1 - easeOut(0.5)), "the pane at T 0.3");
  near(viewAt(timeline, 0.7).bar.y, 0, "the bar at T 0.7");
  assert.equal(viewAt(timeline, 64 + 5 + MOTION.outroS).hidden, true);
  assert.deepEqual(presenceAt({ ...timeline, show: { hidden_between_runs: false } }, -1), { pane: 1, bar: 1 });
  const enter = callsAt(timeline.calls, 39.15).top.enter;
  near(enter.x, -24 * (1 - easeOut(0.5)), "a new call half way");
  near(viewAt(timeline, 12.7).segments[0].glow, 1 - easeOut(0.5), "WALK's glow");
  near(viewAt(timeline, 12.7).segments[1].lift, easeOut(0.5), "FIND's label");
});

test("an outage holds everything at its start, dims the pane and counts SIGNAL LOST", () => {
  const timeline = sample();
  const frozen = viewAt(timeline, 47.5);
  const before = viewAt(timeline, 45);
  assert.equal(frozen.clock, before.clock);
  assert.equal(frozen.pulse, before.pulse);
  assert.equal(frozen.pane.opacity, 0.7);
  assert.deepEqual(frozen.signal, { kind: "robot", text: "SIGNAL LOST · 00:02" });
  assert.equal(viewAt(timeline, 48).signal, null);
  assert.equal(viewAt(timeline, 48).clock, "T+ 00:48");
  const both = { ...timeline, outages: [{ kind: "robot", start: 45, end: null }, { kind: "dashboard", start: 46, since: 45.5, end: null }] };
  assert.equal(outageAt(both, 50).kind, "robot");
});
