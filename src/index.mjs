// diner-overlay: launch-webcast graphics for an agent's tool calls and a run's subtasks.
//
//   import { mountOverlay, viewAt, TIMELINE_FORMAT } from "diner-overlay";
//   import { render } from "diner-overlay/render";   // loads playwright-core only when used
//
// README.md says how to plug it in; schema/TIMELINE.md describes the timeline.
export * from "../web/view.mjs";
export { mountOverlay, staticPage, timelineKey, heartbeat, TimelineStream, WEB_DIRECTORY } from "./server.mjs";
