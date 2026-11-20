// Launch a headless Chrome that belongs to this script alone. The debugging
// port comes from the profile's DevToolsActivePort, so a port collision can
// never attach to someone else's browser.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchChrome(prefix) {
  const chrome =
    process.env.CHROME_BIN ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profile = mkdtempSync(join(tmpdir(), prefix));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-swiftshader",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const close = async () => {
    if (closed) return;
    closed = true;
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
      // Chrome may still be flushing the profile; the directory is disposable.
    }
  };

  // A missing CHROME_BIN arrives as an error event, not a throw from spawn.
  let spawnError = null;
  let closed = false;
  child.on("error", (error) => {
    spawnError = error;
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      void close().finally(() => process.exit(130));
    });
  }

  try {
    let port = 0;
    for (let i = 0; i < 100; i += 1) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("chrome exited before it listened");
      try {
        port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      } catch {
        port = 0;
      }
      if (port > 0) break;
      await sleep(100);
    }
    if (port <= 0) throw new Error("chrome did not publish DevToolsActivePort");
    return { child, port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitForPage(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      /* chrome still starting */
    }
    await sleep(100);
  }
  throw new Error("no CDP page target");
}

export async function connect(port) {
  const target = await waitForPage(port);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) => {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  return { socket, send };
}
