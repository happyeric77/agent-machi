#!/usr/bin/env node
// Watch the live Roster and fail if the named resident never leaves it.
// Usage: node scripts/e2e-ingest-dom.mjs <url> <roster-name> [max-wait-seconds]
import { connect, launchChrome } from "./cdp-chrome.mjs";

const [url, name, maxWaitRaw] = process.argv.slice(2);
if (!url || !name) {
  console.error("usage: e2e-ingest-dom.mjs <url> <roster-name> [max-wait-seconds]");
  process.exit(2);
}
const maxWait = Number(maxWaitRaw || 1200);
if (!Number.isFinite(maxWait)) {
  console.error(`bad max wait: ${maxWaitRaw}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await launchChrome("agent-machi-dom-");

try {
  const { socket, send } = await connect(browser.port);
  const rosterText = async () => {
    const result = await send("Runtime.evaluate", {
      expression:
        'Array.from(document.querySelectorAll(".roster-name"), (e) => e.textContent).join("\\n")',
      returnByValue: true,
    });
    return result.result.value ?? "";
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });
  const started = Date.now();

  let appeared = false;
  for (let i = 0; i < 90; i += 1) {
    if ((await rosterText()).includes(name)) {
      appeared = true;
      break;
    }
    await sleep(1000);
  }
  if (!appeared) {
    throw new Error(`roster never showed ${name}:\n${await rosterText()}`);
  }

  const appearedAt = (Date.now() - started) / 1000;
  let gone;
  for (let waited = 0; waited < maxWait; waited += 2) {
    if (!(await rosterText()).includes(name)) {
      gone = (Date.now() - started) / 1000 - appearedAt;
      break;
    }
    await sleep(2000);
  }
  if (gone === undefined) {
    throw new Error(`roster still shows ${name} after ${maxWait}s`);
  }
  console.log(
    `roster: appeared after ${appearedAt.toFixed(1)}s, dropped ${name} after ${gone.toFixed(1)}s on screen`,
  );
  socket.close();
} catch (error) {
  console.error(`dom check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
