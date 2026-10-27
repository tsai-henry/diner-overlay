# Timeline v1

A timeline is one JSON object that holds everything the overlay draws for one run. Your application builds
it. The overlay knows nothing about your robot, your tools or your tasks. It only places worded text on a
time axis. `timeline-v1.schema.json` beside this file is the same contract as a JSON Schema, and
`examples/sample-timeline.json` is a full example.

```json
{
  "format": "overlay-timeline/1",
  "clock": { "t": 1793071424.4 },
  "start": 1793071338.0,
  "end": null,
  "timer": { "at": 1793071424.4, "value": 86.4, "running": true },
  "segments": [ { "label": "WALK", "line": "SUBTASK #1: WALK TO THE COUNTER", "start": 0, "end": 12.5, "budget": 12.5, "status": "success" } ],
  "calls": [ { "id": 7, "parent": null, "name": "pick_up", "start": 1793071420.0, "end": null, "status": "running",
               "fields": [], "running_fields": [ { "key": "ITEM", "value": "blue mug", "warn": false } ] } ],
  "outages": [],
  "show": { "hidden_between_runs": true, "outro_after_s": 5 }
}
```

## The axis

Every time in a timeline is seconds on one axis, called T.

- **A replay** uses the run's own seconds. T 0 is when the run starts, and the renderer sets T for each frame.
- **Live**, T is epoch seconds. The page keeps its own T, starting from `clock.t` and moving on with the
  browser's clock. Each new timeline resets it, so the page cannot drift.

Live and replay draw through the same function, `viewAt(timeline, t)` in `web/view.mjs`.

## The fields

- **`format`** is always `"overlay-timeline/1"`. The page refuses anything else.
- **`clock`** `{t}` is only in live timelines. It is the axis time when the server built the timeline.
- **`start`** and **`end`** are the axis times the run started and ended. `start` is `null` when there is no
  run, and `end` is `null` while the run goes on.
- **`timer`** `{at, value, running}` is only in live timelines. It is the run's timer, read at axis time `at`.
  The clock (`T+ 01:26`) shows `value`, moved on while `running` is true. It lets the clock stop while a
  person pauses the run, while the page's T, and every motion, keeps moving. Without `timer`, the clock
  shows `T − start`, held at `end`.
- **`segments`** are the subtasks along the bar, on the timer's seconds.
  - `label` is the word under the segment, and `line` is the line above the bar while it is current.
  - `start` is `null` for a subtask that has not started, and `end` is `null` for one that is not done.
  - A current segment with an `end` fills from 0 to 1 over its length. One without an `end` fills against
    its `budget` (expected seconds) and stops at 92 %.
  - `status: "failure"` turns a done segment amber.
- **`calls`** are the tool calls, on the axis, with their fields already worded.
  - `fields` are shown once a call is done, and `running_fields` while it runs. A call whose `end` is after T
    is shown running, so one timeline serves every moment of a replay.
  - A field `{key, value, warn}` reads `KEY value`. `warn: true` makes it amber. Use it for a step that said
    no.
  - `parent` makes a call a stage of another. The newest call shows its two newest stages under it.
  - `hidden: true` counts a call without showing it. `drop_at` stops showing a call from that time on, for a
    call that a later one replaces.
- **`outages`** are periods with no signal, `{kind, start, end, since}`.
  - Inside one, the overlay holds everything at `start`, dims the tool pane, and shows `SIGNAL LOST · 00:07`.
    The count starts at `since`, which defaults to `start`.
  - `end: null` means the signal has not come back. When two outages overlap, the earlier one wins.
  - The live page adds its own outage of kind `dashboard` when nothing has come from the server for 2 s.
- **`show`** holds the display settings.
  - `hidden_between_runs` (default `true`) hides the overlay outside a run, from `start` to the end of the
    outro. `false` keeps it on screen.
  - `outro_after_s` (default 5) is how long after `end` the outro plays.

## Rules the page keeps

- Every text is 18 px or larger, and everything rests 24 px from the frame's edge.
- Nothing is scaled. Motions only move or fade things.
- Everything the overlay draws lies below row 536 of the 1080-row frame. The renderer's band relies on it.
