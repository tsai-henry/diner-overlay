// mountOverlay: the page, the state route, the stream with its beat, and close().
import assert from "node:assert/strict";
import test from "node:test";
import { heartbeat, mountOverlay, timelineKey } from "../src/server.mjs";
import { sample, tinyApp } from "./helpers.mjs";

async function* events(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      yield { event: block.match(/^event: (.*)$/m)?.[1] ?? "message", data: JSON.parse(block.match(/^data: (.*)$/m)[1]) };
    }
  }
}

test("the page, view.mjs and the state route are served, and /overlay redirects to /overlay/", async () => {
  const { app, listen, close } = tinyApp();
  const overlay = mountOverlay(app, { getTimeline: sample });
  const base = await listen();
  try {
    const page = await fetch(`${base}/overlay/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /overlay\.js/);
    const view = await fetch(`${base}/overlay/view.mjs`);
    assert.match(view.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/overlay/fonts/OFL.txt`)).status, 200);
    assert.equal((await fetch(`${base}/overlay/../package.json`)).status, 404);
    const redirect = await fetch(`${base}/overlay?x=1`, { redirect: "manual" });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/overlay/?x=1");
    const state = await (await fetch(`${base}/api/overlay/state`)).json();
    assert.equal(state.format, "overlay-timeline/1");
  } finally {
    overlay.close();
    close();
  }
});

test("the stream pushes a changed timeline, skips an unchanged one, and beats", async () => {
  const { app, listen, close } = tinyApp();
  let timeline = sample();
  const listeners = new Set();
  const overlay = mountOverlay(app, {
    getTimeline: () => timeline, everyMs: 10, heartbeatMs: 300,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  });
  const base = await listen();
  const controller = new AbortController();
  try {
    const messages = events(await fetch(`${base}/api/overlay/stream`, { signal: controller.signal }));
    assert.equal((await messages.next()).value.data.calls.length, 11);
    listeners.forEach((fn) => fn());
    await new Promise((resolve) => setTimeout(resolve, 40));
    timeline = { ...timeline, calls: timeline.calls.slice(0, 3) };
    listeners.forEach((fn) => fn());
    const pushed = (await messages.next()).value;
    assert.equal(pushed.event, "message");
    assert.equal(pushed.data.calls.length, 3);
    assert.equal((await messages.next()).value.event, "beat");
  } finally {
    controller.abort();
    overlay.close();
    assert.equal(listeners.size, 0);
    close();
  }
});

test("timelineKey ignores the clock and a running timer's progress", () => {
  const base = { format: "overlay-timeline/1", clock: { t: 1 }, timer: { at: 1, value: 1, running: true } };
  assert.equal(timelineKey(base), timelineKey({ ...base, clock: { t: 5 }, timer: { at: 5, value: 5, running: true } }));
  assert.notEqual(timelineKey(base), timelineKey({ ...base, timer: { at: 5, value: 9, running: true } }));
  assert.equal(heartbeat(2500), 'event: beat\ndata: {"t":2.5}\n\n');
});

test("mountOverlay refuses to start without getTimeline", () => {
  assert.throws(() => mountOverlay(tinyApp().app, {}), /getTimeline/);
});
