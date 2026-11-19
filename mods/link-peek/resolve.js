// From a terminal selection to the URL under it: which rows `hc read` returns and where its first row sits.
//
// Selection rows count from the oldest row the app's view retains, and that view may keep a different history than
// herdr-core, so positions are anchored on the active screen when a pane reports its scroll. On the alternate screen
// (vim, less) rows start at 0 at its top and scroll is null. `hc read` joins soft-wrapped rows, so its
// lines are wrapped again at the terminal's width (placeLine).

import { hc, terminals, panes } from "herdr";
import { placeLine, urlForSelection } from "./text.js";

const ALL_HISTORY = 100000;

async function read(address, lines) {
  const r = await hc(["read", address, "--lines", String(lines), "--json"]);
  if (r.code !== 0) return null;
  try {
    const d = JSON.parse(r.stdout);
    // `how` with --lines 1: "history" on a normal screen, "stitched" for an agent's redrawn one, "screen" on the alternate
    // screen, "screen" with a `why` when history is unavailable. --lines 0 always says "screen"; a long read of an agent may too.
    return { lines: String(d.text ?? "").split("\n"), history: d.how === "history", alternate: lines === 1 && d.how === "screen" && !d.why };
  } catch {
    return null;
  }
}

const rowsOf = (lines, cols) => lines.reduce((n, l) => n + placeLine(l, cols).rows, 0);

/** The http(s) URL a single double-click selected in `address`, or null. Reads the whole history only when rows count from its start. */
export async function urlUnderSelection(address, selection) {
  const cols = Number(terminals().find((t) => t.address === address)?.cols);
  if (!(cols > 0)) return null;
  const pane = panes().find((p) => p.terminal === address);
  if (!pane) {
    // A terminal outside a pane (a peek, a window, a layout block) has no scroll facts: rows start at the top of the
    // alternate screen, else at the oldest history row.
    const probe = await read(address, 1);
    if (probe?.alternate) {
      // Only --lines 0 joins the soft-wrapped rows of the alternate screen.
      const screen = await read(address, 0);
      return screen ? urlForSelection(screen.lines, cols, 0, selection) : null;
    }
    if (!probe?.history) return null;
    const all = await read(address, ALL_HISTORY);
    return all?.history ? urlForSelection(all.lines, cols, 0, selection) : null;
  }
  const screen = await read(address, 0);
  if (!screen) return null;
  if (!pane.scroll) return urlForSelection(screen.lines, cols, 0, selection);
  const row = Math.min(selection.start.row, selection.end.row);
  const top = pane.scroll.total - pane.scroll.len;
  if (row >= top) return urlForSelection(screen.lines, cols, top, selection);
  const all = await read(address, top - row + 20);
  if (!all?.history) return null;
  const history = all.lines.slice(0, Math.max(0, all.lines.length - screen.lines.length));
  return urlForSelection(history, cols, top - rowsOf(history, cols), selection);
}
