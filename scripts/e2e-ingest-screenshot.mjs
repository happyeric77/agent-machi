#!/usr/bin/env node
// Capture the ingest E2E town with two external residents at their offices.
// Usage: node scripts/e2e-ingest-screenshot.mjs <url> <output.png>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, output] = process.argv.slice(2);
if (!url || !output) {
  console.error("usage: e2e-ingest-screenshot.mjs <url> <output.png>");
  process.exit(2);
}

const chrome =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cdpPort = Number(process.env.E2E_CDP_PORT || 9333);
const profile = mkdtempSync(join(tmpdir(), "agent-machi-shot-"));

const child = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--enable-unsafe-swiftshader",
    "--no-first-run",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      /* chrome still starting */
    }
    await sleep(100);
  }
  throw new Error("no CDP page target");
}

const target = await pageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let seq = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message.result);
  }
});

function send(method, params = {}) {
  const id = (seq += 1);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

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
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(output, Buffer.from(shot.data, "base64"));
console.log(`saved ${output}`);

socket.close();
child.kill("SIGTERM");
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 2000);
  child.once("exit", () => {
    clearTimeout(timer);
    resolve();
  });
});
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  // Chrome may still be flushing its profile; the temp directory is disposable.
}
