// The browser window: terminal-browser in a terminal of its own on this computer, shown in a Herdr window.

import { exec, hc, home, run, terminals, panes, openOverlay } from "herdr";

export const LABEL = "link-peek"; // on the browser's terminal: "browser", or "kept" once it has a tab
export const BAR_H = 30;
const KEY = "link-peek"; // one window: opening another link replaces it
const WIDTH = 0.7, HEIGHT = 0.75;
const FALLBACK = ".local/bin/terminal-browser"; // Herdr's PATH may lack ~/.local/bin
const FOUND_TTL = 60000;

// Module scope on purpose: every copy of this source version shares them.
let found = null;
let latest = 0; // the newest openBrowser call
let opening = 0; // openBrowser calls awaiting hc run: their terminals are not in `started` yet
const started = new Set(); // browser terminals this source version started and has not ended
const shown = new Set(); // browser terminals a live bar shows

/** What openBrowser gives a call a newer one overtook: it ended its own browser. */
export const REPLACED = Symbol("replaced");

const expand = (p) => (p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p);

/** The absolute path of an executable: a path as given, a bare name from PATH; null when there is none. */
async function locate(command) {
  const r = await exec("sh", ["-c", 'case $1 in */*) [ -f "$1" ] && [ -x "$1" ] && printf %s "$1";; *) command -v "$1";; esac', "sh", command]).catch(() => null);
  const path = r?.code === 0 ? r.stdout.trim() : "";
  return path.startsWith("/") ? path : null;
}

/** The browser command: the config's `browserCommand`, else terminal-browser on PATH or in ~/.local/bin; null when none is found. */
export async function browserCommand(config) {
  const own = typeof config?.browserCommand === "string" && config.browserCommand.trim() ? expand(config.browserCommand.trim()) : null;
  if (found && found.own === own && Date.now() - found.at < FOUND_TTL) return found.path;
  const path = own ? await locate(own) : (await locate("terminal-browser")) ?? (await locate(`${home()}/${FALLBACK}`));
  found = { own, at: Date.now(), path };
  return path;
}

// A browser terminal on this computer that no bar or pane shows.
const isLeftover = (t) => typeof t.address === "string" && !t.address.includes("/") && t.labels?.[LABEL] === "browser"
  && !shown.has(t.address) && !panes().some((p) => p.terminal === t.address);

/** Ends a browser terminal. */
export function endBrowser(address) {
  started.delete(address);
  run("terminal.kill", { terminal: address });
}

/** Records whether a bar shows the browser terminal `address`. */
export function showing(address, on) {
  if (on) shown.add(address);
  else shown.delete(address);
}

/**
 * Starts the browser on `url` in a new local terminal and shows it in the window: the terminal's address, null when it
 * did not start, or REPLACED when a newer call started meanwhile.
 */
export async function openBrowser(command, url) {
  const call = ++latest;
  opening++;
  let r;
  try {
    // --no-merge: its own instance, not a tab of another browser; --rm: no finished terminal left behind.
    r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--label", `${LABEL}=browser`, "--", command, "open", "--no-merge", url])
      .catch((e) => ({ code: String(e), stdout: "" }));
  } finally {
    opening--;
  }
  let address = null;
  try { address = r.code === 0 ? JSON.parse(r.stdout).address : null; } catch { /* not JSON: no terminal */ }
  if (typeof address !== "string" || !address) {
    console.log(`link-peek: starting the browser failed (hc run: ${r.code})`);
    return null;
  }
  if (call !== latest) {
    endBrowser(address);
    return REPLACED;
  }
  started.add(address);
  // terminal-browser asks the view for graphics support as it starts, so the window must show the terminal at once.
  openOverlay({ kind: "window", key: KEY, width: WIDTH, height: HEIGHT, layout: { type: "column", children: [
    { type: "block", size: { px: BAR_H }, content: { mod: "link-peek", props: { part: "bar", terminal: address, url } } },
    { type: "block", content: { terminal: address } },
  ] } });
  // The replaced window's bar ends its browser; this catches one of ours whose bar never closed.
  for (const t of terminals()) if (t.address !== address && started.has(t.address) && isLeftover(t)) endBrowser(t.address);
  return address;
}

/**
 * Ends the leftover browser terminals this source version did not start: a crash, a forced quit or a reload left them.
 * False, ending nothing, while a browser is still starting.
 */
export function sweepBrowsers() {
  if (opening > 0) return false;
  for (const t of terminals()) if (!started.has(t.address) && isLeftover(t)) endBrowser(t.address);
  return true;
}
