// The two density settings as plain data: the bar (kanban.density, read by the Dock bar too) and the
// board (kanban.pairs). No Herdr call here.

/** What an older density meant for the board: Compact stacked the columns, Normal did not. */
export const pairsOf = (density) => (density === "compact" ? "on" : density === "normal" ? "off" : "auto");

/** True when the board stacks its pairs. `width`: of the board (undefined before the first layout); Auto stacks below `wide`. */
export const stacks = (pairs, width, wide) => (pairs === "auto" ? typeof width === "number" && width < wide : pairs === "on");

/** How the bar shows: "icons", "names", or "mixed" (names, the panel buttons as icons). Auto: icons below `wide`,
 *  all names from `labels` px; before the first layout `width` is undefined, so mixed. */
export function barLook(density, width, wide, labels) {
  if (density === "compact") return "icons";
  if (density === "normal") return "names";
  if (typeof width === "number" && width < wide) return "icons";
  return width >= labels ? "names" : "mixed";
}
