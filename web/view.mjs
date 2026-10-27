// diner-overlay's view: everything the page draws at one moment, from a timeline.
//
// viewAt(timeline, t) is a pure function. The page (web/overlay.js, which loads this file as ./view.mjs)
// draws only what it returns, live and in replay, and has no CSS animations. So a rendered frame
// matches the live page, and any frame can be drawn on its own.
//
// This file knows nothing about any robot or tool. The application turns its own state into a timeline,
// with its calls already worded into fields. Plain functions with no DOM, no node APIs and no imports,
// so one copy runs in the page and in node.
//
// Timeline v1 ("overlay-timeline/1"), described in schema/TIMELINE.md:
//   {format, clock?, start, end, timer?, segments, calls, outages, show}
//   - The axis. T is seconds on one axis. In a replay it is the subtask timer's seconds (T 0 when the run
//     starts). Live it is epoch seconds, so the page's clock keeps moving while the timer is paused.
//   - clock {t}: live only, the axis time when the server sent the timeline. A replay has no clock.
//   - start, end: the axis times the run started and ended, or null.
//   - timer {at, value, running}: live only, the subtask timer read at axis time `at`. Without it the
//     timer is T − start, held at end.
//   - segments [{label, line, start, end, budget, status}]: the subtasks, on timer seconds. start null
//     means not started, end null means not done. line is the worded line above the bar.
//   - calls [{id, parent, name, start, end, status, hidden, drop_at, fields, running_fields}] on the axis.
//     fields are shown once the call is done, running_fields while it runs. A hidden call only counts.
//     drop_at is when a call stops being shown. A call with a parent is a stage of that call.
//   - outages [{kind, start, end, since?}]: periods with no signal, on the axis. kind is "robot" (the
//     dashboard lost the robot) or "dashboard" (the page lost the dashboard). Inside one, everything is
//     held at `start`, and a SIGNAL LOST line counts from `since` (default `start`). end null: not over.
//   - show {hidden_between_runs, outro_after_s, intro_s, outro_s}: display settings.

export const TIMELINE_FORMAT = "overlay-timeline/1";

// The motions. Each is a function of the seconds since its event, eased with a cubic
// ease-out. They only move or fade things, never scale them, so text stays at its size at every moment,
// and the 24 px margins hold whenever nothing is moving.
export const MOTION = {
  introS: 0.6,       // the pane slides in from the left, the bar rises from below (show.intro_s)
  barDelayS: 0.1,    // the bar starts this much after the pane
  outroS: 0.5,       // the same in reverse, `show.outro_after_s` after the run ends (show.outro_s)
  paneTravelPx: 444, // the pane's width and its margin: fully off the frame
  barTravelPx: 160,  // the bar's height and its margin
  callS: 0.3,        // a new top call fades in and slides
  callTravelPx: 24,
  flashS: 0.4,       // a segment that turns done glows; the next one's label brightens
};

export const easeOut = (p) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;

// The pulse of a running call's dot: one breath every 1.2 s.
export const PULSE_PERIOD_S = 1.2;
// A current segment with no known end fills against its budget and stops here until it is done.
export const LIVE_FILL_CAP = 0.92;

// Seconds as the overlay writes them: one decimal under 10 s, none from 10 s up.
export function secondsText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const value = Math.max(0, seconds);
  return value < 9.95 ? `${value.toFixed(1)} s` : `${Math.round(value)} s`;
}

// The clock: "T+ 01:26".
export function clockText(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = String(Math.floor(whole / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `T+ ${mm}:${ss}`;
}

// How far a segment is filled, 0 to 1. With `capped`, it stops at LIVE_FILL_CAP.
export function fillFraction(elapsed, length, { capped = false } = {}) {
  if (!Number.isFinite(elapsed) || !Number.isFinite(length) || length <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, elapsed / length));
  return capped ? Math.min(LIVE_FILL_CAP, fraction) : fraction;
}

// The subtask timer's seconds at axis time t.
export function timerAt(timeline, t) {
  const timer = timeline.timer;
  if (timer) return Math.max(0, timer.value + (timer.running ? t - timer.at : 0));
  if (timeline.start == null) return 0;
  const until = timeline.end == null ? t : Math.min(t, timeline.end);
  return Math.max(0, until - timeline.start);
}

/* ---------- the subtask bar ---------- */

function segmentState(segment, timer) {
  if (segment.start == null || timer < segment.start) return "pending";
  if (segment.end == null || timer < segment.end) return "current";
  return "done";
}

// Seconds since a segment turned done, for its flash. On the timer's seconds while the timer runs. When
// the last segment ends the timer stops, so the flash then follows the axis from the run's end.
function sinceDone(timeline, segment, timer, t, isLast) {
  if (segment.end == null) return null;
  if (isLast && timeline.end != null && (timeline.timer ? !timeline.timer.running : timer >= segment.end)) return t - timeline.end;
  return timer - segment.end;
}

function barAt(timeline, timer, t) {
  const segments = timeline.segments || [];
  const states = segments.map((segment) => segmentState(segment, timer));
  const current = states.indexOf("current");
  let line = "";
  if (current >= 0) line = segments[current].line;
  else if (segments.length && states.every((state) => state === "done")) line = `ALL ${segments.length} SUBTASKS DONE`;
  return {
    line,
    segments: segments.map((segment, i) => {
      const state = states[i];
      const elapsed = state === "pending" ? null : state === "done" ? segment.end - segment.start : timer - segment.start;
      let fill = 0;
      if (state === "done") fill = 1;
      else if (state === "current") {
        fill = segment.end == null
          ? fillFraction(elapsed, segment.budget, { capped: true })
          : fillFraction(elapsed, segment.end - segment.start);
      }
      const since = state === "done" ? sinceDone(timeline, segment, timer, t, i === segments.length - 1) : null;
      const glow = since != null && since >= 0 && since < MOTION.flashS ? 1 - easeOut(since / MOTION.flashS) : 0;
      // The segment that just became current: its label brightens from the pending look.
      const previous = segments[i - 1];
      const sinceStart = state === "current" && previous?.end != null && segment.start === previous.end ? timer - segment.start : null;
      const lift = sinceStart == null ? 1 : easeOut(sinceStart / MOTION.flashS);
      return {
        label: segment.label,
        state,
        time: elapsed == null ? "" : `${Math.max(0, elapsed).toFixed(1)} s`,
        fill,
        warn: state === "done" && segment.status === "failure",
        glow,
        lift,
      };
    }),
  };
}

/* ---------- the tool calls ---------- */

function callRow(call, t, stages = 0) {
  const running = call.status === "running" || (call.end != null && call.end > t);
  return {
    id: call.id,
    name: call.name,
    running,
    took: running || call.end == null ? "" : secondsText(call.end - call.start),
    fields: (running ? call.running_fields : call.fields) || [],
    stages,
  };
}

// The newest call large with its newest `stageRows` stages, and the calls before it: `historyRows` of
// them, one fewer when the newest call shows stages. Calls that start after t are left out, and a call
// that ends after t is shown running.
//   {count, top: {…row, stages: [row]} | null, history: [row]}
export function callsAt(calls, t, { historyRows = 3, stageRows = 2 } = {}) {
  const seen = (calls || []).filter((call) => call.start != null && call.start <= t);
  const ids = new Set(seen.map((call) => call.id));
  const isStage = (call) => call.parent != null && ids.has(call.parent);
  const stagesOf = new Map();
  for (const call of seen) {
    if (!isStage(call)) continue;
    if (!stagesOf.has(call.parent)) stagesOf.set(call.parent, []);
    stagesOf.get(call.parent).push(call);
  }
  const shown = seen.filter((call) => !isStage(call) && !call.hidden && (call.drop_at == null || t < call.drop_at));
  const [first, ...rest] = shown.reverse();
  const entering = first ? Math.min(1, Math.max(0, (t - first.start) / MOTION.callS)) : 1;
  const top = first ? {
    ...callRow(first, t),
    enter: { x: -MOTION.callTravelPx * (1 - easeOut(entering)), opacity: easeOut(entering) },
    stages: (stagesOf.get(first.id) || []).slice(-stageRows).reverse().map((stage) => callRow(stage, t)),
  } : null;
  const rows = top?.stages.length ? historyRows - 1 : historyRows;
  return { count: seen.length, top, history: rest.slice(0, rows).map((call) => callRow(call, t)) };
}

/* ---------- the intro and the outro ---------- */

// How far in the pane and the bar are, 0 (off) to 1 (in place), at axis time t.
// The intro's and the outro's seconds: show.intro_s and show.outro_s, else MOTION's.
export function motionTimes(show = {}) {
  const pick = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return { introS: pick(show.intro_s, MOTION.introS), outroS: pick(show.outro_s, MOTION.outroS) };
}

export function presenceAt(timeline, t) {
  const show = timeline.show || {};
  if (show.hidden_between_runs === false) return { pane: 1, bar: 1 };
  if (timeline.start == null || t < timeline.start) return { pane: 0, bar: 0 };
  const { introS, outroS } = motionTimes(show);
  const intro = t - timeline.start;
  let pane = easeOut(intro / introS);
  let bar = easeOut((intro - MOTION.barDelayS) / introS);
  if (timeline.end != null) {
    // The outro is the intro played backwards in outroS: the bar leaves first, then the pane.
    const outro = t - (timeline.end + (show.outro_after_s ?? 5));
    const scale = outroS / (introS + MOTION.barDelayS);
    if (outro >= 0) {
      bar = Math.min(bar, easeOut(1 - outro / (introS * scale)));
      pane = Math.min(pane, easeOut(1 - (outro - MOTION.barDelayS * scale) / (introS * scale)));
    }
  }
  return { pane, bar };
}

/* ---------- signal loss ---------- */

// The pane's opacity while the signal is lost.
export const LOST_PANE_OPACITY = 0.7;

// The outage that holds t, if any. When two overlap, such as the robot lost and then the dashboard,
// the earlier one wins, so the overlay stays held where the signal was first lost.
export function outageAt(timeline, t) {
  let found = null;
  for (const outage of timeline.outages || []) {
    if (outage.start != null && outage.start <= t && (outage.end == null || t < outage.end)
      && (!found || outage.start < found.start)) found = outage;
  }
  return found;
}

/* ---------- the whole view ---------- */

// Everything the page draws at axis time t, as plain data.
//   {clock, line, segments: [{label, state, time, fill, warn, glow, lift}],
//    calls: {count, top: {…, enter: {x, opacity}}, history}, pulse,
//    pane: {x, opacity}, bar: {y, opacity}, shade: {opacity}, hidden, signal: null | {kind, text}}
// pulse is 0 to 1, the running dot's ring. x and y are pixel offsets from the resting place.
// Inside an outage the overlay holds its values at the outage's start, dims the pane and says
// SIGNAL LOST with the time since. When the signal returns it jumps to the true time.
export function viewAt(timeline, t) {
  const outage = outageAt(timeline, t);
  if (!outage) return viewAtTime(timeline, t);
  // A loss from before the run lets the intro play, then holds, so the SIGNAL LOST line is seen.
  const introEnd = timeline.start == null ? -Infinity : timeline.start + motionTimes(timeline.show).introS + MOTION.barDelayS;
  const view = viewAtTime(timeline, Math.max(outage.start, Math.min(t, introEnd)));
  return {
    ...view,
    t,
    pane: { ...view.pane, opacity: LOST_PANE_OPACITY },
    signal: { kind: outage.kind, text: `SIGNAL LOST · ${clockText(t - (outage.since ?? outage.start)).slice(3)}` },
  };
}

function viewAtTime(timeline, t) {
  const timer = timerAt(timeline, t);
  const bar = barAt(timeline, timer, t);
  const presence = presenceAt(timeline, t);
  return {
    t,
    clock: clockText(timer),
    line: bar.line,
    segments: bar.segments,
    calls: callsAt(timeline.calls, t),
    pulse: 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / PULSE_PERIOD_S),
    pane: { x: -MOTION.paneTravelPx * (1 - presence.pane), opacity: 1 },
    bar: { y: MOTION.barTravelPx * (1 - presence.bar), opacity: presence.bar },
    shade: { opacity: presence.bar },
    hidden: presence.pane === 0 && presence.bar === 0,
    signal: null,
  };
}

// The axis time a live page should draw at: the server's clock.t, moved on by the seconds since the
// message arrived. Replay has no clock and draws at the T it is given.
export function liveTime(timeline, secondsSinceMessage) {
  const base = timeline.clock?.t ?? 0;
  return base + Math.max(0, secondsSinceMessage);
}
