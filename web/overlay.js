// diner-overlay's page. It draws only what viewAt(timeline, t) returns (view.mjs), into a DOM built
// once, so a screenshot every 33 ms is cheap. Nothing moves by itself: there are no CSS animations, and
// every motion is computed from T. Two sources, one timeline v1:
//   live (default)               the pushed <api>/stream, else polling <api>/state; the page keeps its
//                                own T from the server's clock and redraws every frame
//   ?replay=<url>&t=<s>[&play=1] load a timeline file once and draw the run at T = t
// <api> is ?api=<path>, /api/overlay by default (src/server.mjs's mountOverlay serves both).
// The renderer (src/render.mjs) calls window.overlaySetTime(t) per frame after window.overlayReady
// resolves. The tool pane is always the same height (overlay.css), and rows that do not fit are left
// out, oldest first.
import { TIMELINE_FORMAT, liveTime, viewAt } from "./view.mjs";

const params = new URLSearchParams(location.search);
const replayUrl = params.get("replay");
const api = (params.get("api") || "/api/overlay").replace(/\/+$/, "");
const stage = document.getElementById("stage");
const shade = stage.querySelector(".shade");
const pane = document.getElementById("pane");
const progress = document.getElementById("progress");

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function show(node, visible) {
  node.classList.toggle("hidden", !visible);
}

// An inline style, written only when it changes.
function setStyle(node, name, value) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

const px = (value) => `${Math.round(value * 100) / 100}px`;

/* ---------- build the DOM once ---------- */

const tools = el("div", "tools", pane);
const toolsHead = el("div", "tools-head", tools);
el("span", "lbl", toolsHead, "AGENT TOOL CALLS");
const countText = el("span", "lbl count", toolsHead, "");
const idle = el("div", "idle", tools, "Waiting for the first call");

function callRow(parent, kind) {
  const row = el("div", "row", parent);
  const head = el("div", "head", row);
  const dot = el("span", kind === "stage" ? "dot small" : "dot", head);
  const name = el("span", kind === "top" ? "name cur" : kind === "stage" ? "name stage-name" : "name", head);
  const took = el("span", "took", head);
  const kv = el("div", "kv", row);
  return { row, dot, name, took, kv, key: "" };
}

const top = callRow(tools, "top");
top.row.classList.add("first");
const stagesBox = el("div", "stages", tools);
const stageRows = [callRow(stagesBox, "stage"), callRow(stagesBox, "stage")];
stageRows[0].row.classList.add("first");
const historyRows = [callRow(tools, "history"), callRow(tools, "history"), callRow(tools, "history")];

const progressHead = el("div", "progress-head", progress);
const clock = el("span", "clock", progressHead, "T+ 00:00");
const subtask = el("span", "subtask", progressHead, "");
const signal = el("span", "signal hidden", progressHead, "");
const segsBox = el("div", "segs", progress);
const phasesBox = el("div", "phases", progress);
let segNodes = [];

/* ---------- draw ---------- */

function drawFields(slot, fields) {
  const key = JSON.stringify(fields);
  if (key === slot.key) return;
  slot.key = key;
  slot.kv.replaceChildren(...fields.map((field) => {
    const span = document.createElement("span");
    if (field.warn) span.className = "warn";
    const i = document.createElement("i");
    i.textContent = field.key;
    span.append(i, field.value);
    return span;
  }));
}

function drawCall(slot, call, { large = false } = {}) {
  show(slot.row, Boolean(call));
  if (!call) return;
  setText(slot.name, call.name);
  show(slot.dot, call.running);
  setText(slot.took, call.running ? "" : call.took);
  show(slot.took, !call.running && Boolean(call.took));
  if (!large) slot.name.classList.toggle("live", call.running);
  drawFields(slot, call.fields);
}

function drawCalls(view) {
  setText(countText, view.count ? String(view.count) : "");
  show(idle, !view.top);
  drawCall(top, view.top, { large: true });
  const enter = view.top?.enter ?? { x: 0, opacity: 1 };
  setStyle(top.row, "transform", enter.x ? `translateX(${px(enter.x)})` : "");
  setStyle(top.row, "opacity", enter.opacity < 1 ? enter.opacity.toFixed(3) : "");
  const stages = view.top?.stages ?? [];
  show(stagesBox, stages.length > 0);
  stageRows.forEach((slot, i) => drawCall(slot, stages[i]));
  historyRows.forEach((slot, i) => drawCall(slot, view.history[i]));
  // The pane's height is fixed: leave out the oldest history rows, then the older stage, until the rest fit.
  const removable = [...historyRows].reverse().concat([stageRows[1]]).map((slot) => slot.row);
  for (const row of removable) {
    if (tools.scrollHeight <= tools.clientHeight) break;
    show(row, false);
  }
}

function drawBar(view) {
  setText(clock, view.clock);
  setText(subtask, view.line);
  if (segNodes.length !== view.segments.length) {
    segsBox.replaceChildren();
    phasesBox.replaceChildren();
    segNodes = view.segments.map(() => {
      const seg = el("div", "seg", segsBox);
      const fill = el("div", "fill", seg);
      const ph = el("span", "ph", phasesBox);
      const label = document.createTextNode("");
      const time = el("b", "", null);
      ph.append(label, time);
      return { seg, fill, ph, label, time };
    });
  }
  view.segments.forEach((s, i) => {
    const node = segNodes[i];
    node.seg.classList.toggle("done", s.state === "done" && !s.warn);
    node.seg.classList.toggle("warn", s.warn);
    const width = s.state === "current" ? `${(s.fill * 100).toFixed(2)}%` : "0%";
    if (node.fill.style.width !== width) node.fill.style.width = width;
    if (node.label.data !== s.label) node.label.data = s.label;
    setText(node.time, s.time);
    show(node.time, Boolean(s.time));
    node.ph.classList.toggle("pending", s.state === "pending");
    node.ph.classList.toggle("warn", s.warn);
    // A segment that just turned done glows white; the label of the one after it brightens.
    setStyle(node.seg, "box-shadow", s.glow > 0 ? `0 0 ${px(4 + 10 * s.glow)} rgba(255,255,255,${(0.9 * s.glow).toFixed(3)})` : "");
    setStyle(node.ph, "opacity", s.state === "current" && s.lift < 1 ? (0.5 + 0.5 * s.lift).toFixed(3) : "");
  });
}

let lastPulse = "";
function draw(view) {
  const pulse = view.pulse.toFixed(3);
  if (pulse !== lastPulse) stage.style.setProperty("--pulse", pulse);
  lastPulse = pulse;
  // The intro and the outro: the pane slides from the left, the bar and the shade rise and fade.
  show(stage, !view.hidden);
  setStyle(pane, "transform", view.pane.x ? `translateX(${px(view.pane.x)})` : "");
  setStyle(pane, "opacity", view.pane.opacity < 1 ? String(view.pane.opacity) : "");
  // Signal lost: an amber line in the bar's head with the time since.
  show(signal, Boolean(view.signal));
  setText(signal, view.signal?.text ?? "");
  setStyle(progress, "transform", view.bar.y ? `translateY(${px(view.bar.y)})` : "");
  setStyle(progress, "opacity", view.bar.opacity < 1 ? view.bar.opacity.toFixed(3) : "");
  setStyle(shade, "opacity", view.shade.opacity < 1 ? view.shade.opacity.toFixed(3) : "");
  if (view.hidden) return;
  drawCalls(view.calls);
  drawBar(view);
}

/* ---------- sources ---------- */

// A poll that never overlaps itself.
function startPoll(run, intervalMs) {
  const controller = new AbortController();
  let stopped = false;
  const next = async () => {
    try {
      await run(controller.signal);
    } catch {
      // A failed tick is retried on the next one.
    }
    if (!stopped) setTimeout(next, intervalMs);
  };
  next();
  return () => { stopped = true; controller.abort(); };
}

const fontsReady = Promise.all([400, 700].map((weight) => document.fonts.load(`${weight} 20px "D-DIN"`)))
  .then(() => document.fonts.ready);

if (params.get("backdrop")) stage.style.backgroundImage = `url("${params.get("backdrop")}")`;

function checkTimeline(data, where) {
  if (data?.format !== TIMELINE_FORMAT) throw new Error(`${where}: not a timeline (${TIMELINE_FORMAT}); see schema/TIMELINE.md`);
  return data;
}

if (replayUrl) {
  stage.classList.add("replay-mode");
  let timeline = null;
  let current = Number(params.get("t") ?? 0) || 0;
  window.overlaySetTime = (t) => {
    current = Number(t);
    if (timeline) draw(viewAt(timeline, current));
    return current;
  };
  window.overlayReady = Promise.all([fetch(replayUrl).then((r) => {
    if (!r.ok) throw new Error(`replay ${replayUrl}: ${r.status}`);
    return r.json();
  }), fontsReady]).then(([data]) => {
    timeline = checkTimeline(data, replayUrl);
    const duration = timeline.end ?? 0;
    window.overlayReplay = { duration, calls: timeline.calls.length };
    window.overlaySetTime(current);
    if (params.get("play") === "1") player(duration);
    return true;
  });
} else {
  // Live: the page keeps its own T. Each message resets it to the server's clock.t, and between messages
  // it moves on with performance.now(), so the clock and the fill move every frame and cannot drift.
  stage.classList.add("live-mode");
  window.overlaySetTime = () => null;
  let timeline = null;
  let receivedAt = 0;
  const receive = (data) => {
    timeline = checkTimeline(data, `${api}/stream`);
    receivedAt = performance.now();
  };
  // The page loses the dashboard: no message, not even a beat, for LOST_AFTER_MS. It then draws a local
  // outage of kind "dashboard", held from the moment it noticed, counting from the last message. The next
  // message brings a fresh timeline and ends it.
  const LOST_AFTER_MS = 2000;
  const axisAt = (ms) => liveTime(timeline, (ms - receivedAt) / 1000);
  const frame = (now) => {
    if (timeline) {
      let drawn = timeline;
      if (heardAt && now - heardAt > LOST_AFTER_MS) {
        const lost = { kind: "dashboard", start: axisAt(heardAt + LOST_AFTER_MS), since: axisAt(heardAt), end: null };
        drawn = { ...timeline, outages: [...(timeline.outages || []), lost] };
      }
      draw(viewAt(drawn, axisAt(now)));
    }
    requestAnimationFrame(frame);
  };
  // The stream pushes each change and beats every second. EventSource reconnects by itself; if the
  // stream gives nothing within 3 s, or is closed for good, the page polls the old route instead.
  let heardAt = 0;
  let polling = null;
  const poll = () => {
    if (polling) return;
    polling = startPoll(async (signal) => {
      const response = await fetch(`${api}/state`, { signal, cache: "no-store" });
      if (!response.ok) return;
      receive(await response.json());
      heardAt = performance.now();
    }, 250);
  };
  window.overlayLive = () => ({ source: polling ? "poll" : "stream", heardAt, receivedAt });
  window.overlayReady = fontsReady.then(() => new Promise((resolve) => {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      requestAnimationFrame(frame);
      resolve(true);
    };
    const onTimeline = (data) => { receive(data); heardAt = performance.now(); start(); };
    if (typeof EventSource === "function" && params.get("poll") !== "1") {
      const source = new EventSource(`${api}/stream`);
      source.onmessage = (event) => { if (!polling) onTimeline(JSON.parse(event.data)); };
      source.addEventListener("beat", () => { heardAt = performance.now(); });
      source.onerror = () => { if (source.readyState === EventSource.CLOSED) poll(); };
      setTimeout(() => { if (!timeline) { source.close(); poll(); } }, 3000);
    } else poll();
    const waitForPoll = setInterval(() => { if (timeline) { clearInterval(waitForPoll); start(); } }, 50);
  }));
}

// &play=1: a Play button and a slider, for checking a replay by eye.
function player(duration) {
  const box = el("div", "panel player", document.body);
  const button = el("button", "", box, "Play");
  const slider = el("input", "", box);
  Object.assign(slider, { type: "range", min: 0, max: String(duration), step: "0.1" });
  const readout = el("span", "", box, "");
  let playing = false, last = 0;
  const update = (t) => { slider.value = String(t); readout.textContent = `T = ${Number(t).toFixed(1)} s`; };
  update(window.overlaySetTime(Number(params.get("t") ?? 0) || 0));
  slider.addEventListener("input", () => update(window.overlaySetTime(Number(slider.value))));
  button.addEventListener("click", () => {
    playing = !playing;
    button.textContent = playing ? "Pause" : "Play";
    last = performance.now();
    if (playing) requestAnimationFrame(step);
  });
  function step(now) {
    if (!playing) return;
    const t = Math.min(duration, Number(slider.value) + (now - last) / 1000);
    last = now;
    update(window.overlaySetTime(t));
    if (t < duration) requestAnimationFrame(step);
  }
}
