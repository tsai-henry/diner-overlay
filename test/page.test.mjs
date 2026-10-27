// The page in Chromium: the layout guard and the determinism check. DINER_OVERLAY_BROWSER=1 runs them.
import assert from "node:assert/strict";
import test from "node:test";
import { serve } from "../src/render.mjs";
import { SKIP_BROWSER, sample } from "./helpers.mjs";

async function openPage(chromium, base, t) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/overlay/?replay=/timeline.json&t=${t}`);
  await page.evaluate(() => window.overlayReady);
  return { browser, page, errors };
}

// Each visible text's size, and the pane's and the bar's boxes.
function measure() {
  const texts = [];
  const walker = document.createTreeWalker(document.getElementById("stage"), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.trim()) continue;
    const el = node.parentElement;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || el.closest(".hidden")) continue;
    texts.push({ text: node.data.trim(), size: parseFloat(getComputedStyle(el).fontSize) });
  }
  const box = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
  return { texts, pane: box("pane"), bar: box("progress") };
}

test("every visible text is 18 px or more, and the pane and the bar rest 24 px from the edges", { skip: SKIP_BROWSER }, async () => {
  const { chromium } = await import("playwright-core");
  const server = await serve(Buffer.from(JSON.stringify(sample())));
  const { browser, page, errors } = await openPage(chromium, server.base, 30);
  try {
    for (const t of [30, 46, 50, 58]) {
      await page.evaluate((value) => window.overlaySetTime(value), t);
      const { texts, pane, bar } = await page.evaluate(measure);
      assert.ok(texts.length > 10, `T ${t}: ${texts.length} texts`);
      for (const { text, size } of texts) assert.ok(size >= 18, `T ${t}: "${text}" is ${size} px`);
      assert.equal(pane.left, 24);
      assert.equal(pane.bottom, 1056);
      assert.equal(bar.bottom, 1056);
      assert.equal(bar.right, 1896);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a frame is the same whether the page stepped to it or jumped to it", { skip: SKIP_BROWSER }, async () => {
  const { chromium } = await import("playwright-core");
  const server = await serve(Buffer.from(JSON.stringify(sample())));
  const stepped = await openPage(chromium, server.base, 0);
  const jumped = await openPage(chromium, server.base, 46.3);
  try {
    for (let t = 0; t <= 46.3001; t += 0.1) await stepped.page.evaluate((value) => window.overlaySetTime(value), Math.round(t * 10) / 10);
    const a = await stepped.page.screenshot({ omitBackground: true });
    const b = await jumped.page.screenshot({ omitBackground: true });
    assert.ok(a.equals(b), "the two PNGs differ");
    assert.deepEqual([...stepped.errors, ...jumped.errors], []);
  } finally {
    await stepped.browser.close();
    await jumped.browser.close();
    await server.close();
  }
});
