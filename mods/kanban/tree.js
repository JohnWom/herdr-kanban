// The trees of agents: which terminal started which.
//
// A terminal's parent is the core's `parent` (a child that dies with its parent), else its label
// `tree.parent` (a child started with `hc run --outlive-parent`: the core forgets that link, so the
// starter writes it as a label). A label holds an address of the child's own machine, so a bare id
// ("t3") on a remote child is qualified with that machine ("vps/t3"), as the app names it.
// Pure functions over `terminals()`, so a Node script can test them.

export const PARENT_LABEL = "tree.parent";

const machineOf = (address) => {
  const i = String(address).lastIndexOf("/");
  return i < 0 ? "" : String(address).slice(0, i);
};

/** The parent address of terminal `t`, named as the app names `t.address`; null when it has none. */
export function parentOf(t) {
  const raw = t?.parent || t?.labels?.[PARENT_LABEL];
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.includes("/")) return s || null;
  const m = machineOf(t.address);
  return m ? `${m}/${s}` : s;
}

/** The live terminals as a forest: `byAddr` (address -> terminal) and `kids` (address -> its live
 *  children, oldest first). A finished terminal is left out, and so is a link to one. */
export function forest(terms) {
  const live = (Array.isArray(terms) ? terms : []).filter((t) => t?.address && !t.finished_ms && t.state !== "finished");
  const byAddr = new Map(live.map((t) => [String(t.address), t]));
  const kids = new Map();
  for (const t of live) {
    const p = parentOf(t);
    if (!p || p === t.address || !byAddr.has(p)) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
  return { byAddr, kids };
}

/** The live parent of `address` in `f`, or null. */
export function up(f, address) {
  const p = parentOf(f.byAddr.get(address));
  return p && f.byAddr.has(p) && p !== address ? p : null;
}

/** The addresses from the root of its tree down to `address` (just [address] when it has no parent). */
export function pathTo(f, address) {
  const out = [], seen = new Set();
  for (let cur = address; cur && f.byAddr.has(cur) && !seen.has(cur); cur = up(f, cur)) {
    seen.add(cur);
    out.unshift(cur);
  }
  return out;
}

/** The tree under `root`, depth first: [{ address, depth }], at most `max` rows. */
export function flatten(f, root, max = 200) {
  const out = [], seen = new Set();
  const walk = (address, depth) => {
    if (out.length >= max || seen.has(address)) return;
    seen.add(address);
    out.push({ address, depth });
    for (const k of f.kids.get(address) ?? []) walk(String(k.address), depth + 1);
  };
  if (f.byAddr.has(root)) walk(root, 0);
  return out;
}

/** The tree move `dir` from `address`: "up" (its parent), "down" (its first child), "next" / "prev"
 *  (the sibling after or before it, round the end). Null when there is nowhere to go. */
export function step(f, address, dir) {
  if (dir === "up") return up(f, address);
  if (dir === "down") return f.kids.get(address)?.[0]?.address ?? null;
  const p = up(f, address);
  const sibs = p ? f.kids.get(p) ?? [] : [];
  if (sibs.length < 2) return null;
  const i = sibs.findIndex((t) => t.address === address);
  return sibs[(i + (dir === "prev" ? sibs.length - 1 : 1)) % sibs.length].address;
}
