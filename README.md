# diner-overlay

Launch-webcast graphics for a robot agent's tool calls and a run's subtasks. One web page serves two uses.

- **Live,** as a 1920×1080 transparent browser source in OBS.
- **Recorded,** rendered to a transparent video layer (ProRes 4444 `.mov` or VP9 `.webm`) that an editor drops
  on a track above the footage.

![The sample timeline at T 30 and T 45](https://raw.githubusercontent.com/tsai-henry/diner-overlay/v0.1.0/examples/sample.jpg)

The overlay draws two things.

- **The tool pane** at the bottom left. The newest tool call is large, with a pulsing dot while it runs and
  its two newest stages under it. The calls before it follow. Details are short fields such as `ITEM blue
  mug`, and amber marks a step that said no.
- **The subtask bar** along the bottom. A clock (`T+ 01:26`), the current subtask's line, and one segment
  per subtask that fills as it runs.

It also has an intro and an outro, a short entry for each new call, a flash when a subtask is done, and a
freeze with an amber `SIGNAL LOST` when the signal drops.

## How it works

Your application describes a run as a **timeline**, one JSON object (`schema/TIMELINE.md`). The page draws
only what the pure function `viewAt(timeline, t)` returns for a moment T. There are no CSS animations, so a
rendered frame matches the live page exactly, and any frame can be drawn on its own.

The overlay knows nothing about your robot. Your code words each tool call into fields, and names the
subtasks. The overlay places that text on screen.

## Install

```bash
npm install github:tsai-henry/diner-overlay#v0.1.0
```

Rendering also needs Chromium for `playwright-core` and ffmpeg.

```bash
npx playwright-core install chromium-headless-shell
```

ffmpeg comes from `--ffmpeg`, then `$FFMPEG`, then `PATH`.

## Show it live

1. Mount the overlay on your Express app, before any catch-all route.

   ```js
   import { mountOverlay } from "diner-overlay";

   const overlay = mountOverlay(app, {
     getTimeline: () => buildTimeline(myState),   // your timeline v1
     subscribe: (changed) => {                     // call changed() when the state may have changed
       myState.on("change", changed);
       return () => myState.off("change", changed);
     },
   });
   // On shutdown: overlay.close();
   ```

2. Open `http://<host>:<port>/overlay/` in a browser to check it.
3. In OBS, add a **Browser** source of 1920×1080 with that URL. Turn off **Shutdown source when not
   visible**, and put the source above the camera.

The page reads `GET /api/overlay/stream`, an event stream. The server pushes a new timeline on each change,
at most every 50 ms, and a `beat` event every second. If the stream fails, the page polls
`GET /api/overlay/state`. `basePath` and `apiBase` move the routes; the page then needs `?api=<apiBase>`.

## Render a run

1. Write the run's timeline to a file. T 0 is the start of the run.
2. Render it.

   ```bash
   npx diner-overlay render --timeline run.json --out layer.mov --t0 0 --t1 70
   ```

   - `--out layer.webm` writes VP9 with alpha, and `--out frames/` writes one PNG per frame.
   - `--times 30,46.5` renders single moments, and `--shots shots.json` follows a cut's shot list
     (`{"shots": [[name, t_start, t_end, speed], ...]}`).
   - `--composite video.mp4 --out-video out.mp4 [--video-start S]` lays the layer over footage as H.264.
3. Check a timeline by eye with `npx diner-overlay preview --timeline run.json`, which prints a URL with a
   Play button and a slider.

The speed options default to the fastest setting.

- `--workers N` runs N browsers, each with its own encoder, and joins the slices without re-encoding. The
  default is 8.
- `--band on` renders only the bottom 544 rows and pads them back to 1080, since the overlay draws nothing
  above row 536.
- `--gpu auto` puts Chrome on an NVIDIA GPU when `libEGL_nvidia.so.0` exists, and prints the WebGL renderer
  it got. `on` and `off` force a mode.

The same renderer is a function too.

```js
import { render, spanTimes } from "diner-overlay/render";
await render("run.json", "layer.mov", spanTimes(0, 70, 30), { workers: 8 });
```

## The sample

`examples/sample-timeline.json` is a made-up run of a diner robot that fetches a blue mug for table 7. It has
a first look that misses, a pick with four stages, a three-second signal loss, and a failed last step.

```bash
npx diner-overlay render --timeline examples/sample-timeline.json --out sample.mov --t0 0 --t1 70
```

## Rules the page keeps

- Every text is 18 px or larger, and everything rests 24 px from the frame's edge.
- Motions only move or fade things. Nothing is scaled.
- Everything lies below row 536, which the renderer's band relies on.

## Tests

1. `npm test` checks the view, the server and the renderer's small parts.
2. `npm run test:browser` adds the Chromium checks: the text sizes and margins, a frame drawn the same
   whether the page stepped to it or jumped to it, and full renders of the sample to PNG, `.mov` and `.webm`
   with alpha.
3. `npx diner-overlay selftest` runs the render checks alone.

## Licence

Apache-2.0 (`LICENSE`, `NOTICE`). The bundled D-DIN fonts in `web/fonts/` are Datto's, under the SIL Open
Font License 1.1 (`web/fonts/OFL.txt`).
