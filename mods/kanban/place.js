// Where the tab panel ("detail") sits next to the board: no Herdr calls, so it can be tested on its own.
// right: board | detail in their row; left: detail | board; bottom: a column MAIN with the board over the panel,
// in the place of the board. The other children of the row (the Files/Git panel) stay where they are.

export const PLACES = ["right", "left", "bottom"];
export const MAIN = "work-main";
/** The size of the panel that a place keeps: its width at a side, its height at the bottom. */
export const axis = (place) => (place === "bottom" ? "bottom" : "side");

function parentOf(node, id) {
  for (const child of node?.children ?? []) {
    if (child?.id === id) return node;
    const hit = parentOf(child, id);
    if (hit) return hit;
  }
  return null;
}

/** The place of the panel in `root`; null for a tree this does not know (then nothing moves it). */
export function placeOf(root) {
  const p = parentOf(root, "detail");
  const i = p?.children.findIndex((c) => c.id === "detail"), j = p?.children.findIndex((c) => c.id === "board");
  if (!p || j < 0) return null;
  if (p.type === "row") return j < i ? "right" : "left";
  return p.type === "column" && p.id === MAIN && p.children.length === 2 && j < i ? "bottom" : null;
}

const px = (v) => (typeof v === "number" && v > 0 ? v : null);

/** Moves the panel to `place`. `sizes` = { side, bottom } px, `held` = the px kept while maximized (board.hidden).
 *  The size of the old place is saved in sizes (or held); a move to the other axis takes the size of the new one.
 *  Returns { tree, sizes, held, px } (px: the size set on the panel, if any), or null when it is there already
 *  or the tree is not one it knows. */
export function movePanel(root, place, sizes, held) {
  const from = placeOf(root);
  if (!from || from === place || !PLACES.includes(place)) return null;
  const tree = JSON.parse(JSON.stringify(root));
  const holder = parentOf(tree, "detail"), detail = holder.children.find((c) => c.id === "detail");
  const board = holder.children.find((c) => c.id === "board");
  if (place === "bottom" && parentOf(tree, MAIN)) return null;
  // The row of the board: its own parent, or the parent of MAIN.
  const row = from === "bottom" ? parentOf(tree, MAIN) : holder;
  if (row?.type !== "row") return null;
  const max = Boolean(board.hidden), next = { ...sizes };
  const now = px(max ? held : detail.size?.px);
  if (now) next[axis(from)] = now;
  let set = null;
  if (axis(from) !== axis(place)) {
    const want = px(next[axis(place)]);
    if (max) held = want ?? held;
    else if (want) { detail.size = { px: want }; set = want; }
  }
  const kids = row.children.filter((c) => c.id !== "detail");
  const at = kids.findIndex((c) => c.id === (from === "bottom" ? MAIN : "board"));
  if (place === "bottom") {
    kids.splice(at, 1, { id: MAIN, type: "column", ...(row.gap != null ? { gap: row.gap } : {}),
      ...(board.min != null ? { min: board.min } : {}), children: [board, detail] });
  } else {
    kids.splice(at, 1, ...(place === "left" ? [detail, board] : [board, detail]));
  }
  row.children = kids;
  return { tree, sizes: next, held, px: set };
}
