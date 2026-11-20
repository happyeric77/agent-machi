#!/usr/bin/env node
// Capture the ingest E2E town with two external residents at their offices.
// Usage: node scripts/e2e-ingest-screenshot.mjs <url> <output.png>
import { writeFileSync } from "node:fs";
import { connect, launchChrome } from "./cdp-chrome.mjs";

const [url, output] = process.argv.slice(2);
if (!url || !output) {
  console.error("usage: e2e-ingest-screenshot.mjs <url> <output.png>");
  process.exit(2);
}
const zoom = Number(process.env.E2E_ZOOM ?? -420);
if (!Number.isFinite(zoom)) {
  console.error(`bad E2E_ZOOM: ${process.env.E2E_ZOOM}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await launchChrome("agent-machi-shot-");

try {
  const { socket, send } = await connect(browser.port);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });
  // The director debounces for 3s and the residents then walk to their offices.
  await sleep(16000);
  // Zoom in so the office signs are legible next to the Roster.
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 720,
    y: 450,
    deltaX: 0,
    deltaY: zoom,
  });
  await sleep(2500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(output, Buffer.from(shot.data, "base64"));
  console.log(`saved ${output}`);
  socket.close();
} finally {
  await browser.close();
}
