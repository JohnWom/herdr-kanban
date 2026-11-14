// The filter of the board as plain data: no Herdr call here, so it runs with made-up agents too.
// Saved as { kind: "all" | "current" | "space" | "machine", id? }: a space id, or a machine name (null: this computer).

/** The saved filter, or null when `v` is not one. */
export function parseFilter(v) {
  if (!v || typeof v !== "object") return null;
  if (v.kind === "all" || v.kind === "current") return { kind: v.kind };
  if (v.kind === "space" && typeof v.id === "string" && v.id) return { kind: "space", id: v.id };
  if (v.kind === "machine" && (v.id == null || typeof v.id === "string")) return { kind: "machine", id: v.id || null };
  return null;
}

/** The filter from the keys of older versions: kanban.scope "space" kept kanban.scopeSpace, or the active space without one. */
export const migrateFilter = (scope, space) => (scope !== "space" ? { kind: "all" }
  : typeof space === "string" && space ? { kind: "space", id: space } : { kind: "current" });

/** What the filter keeps now: { kind, space? (an entry of `spaces`), machine? (null: this computer) }.
 *  `machines`: without the temporary ones. A space or machine that is gone, "current" with no active
 *  space, and a machine filter with one machine left all keep every agent. */
export function resolveFilter(f, spaces, machines) {
  if (f.kind === "current" || f.kind === "space") {
    const space = f.kind === "current" ? spaces.find((p) => p.active) : spaces.find((p) => p.id === f.id);
    return space ? { kind: f.kind, space } : { kind: "all" };
  }
  if (f.kind === "machine" && machines.length > 1 && machines.some((m) => (m.name ?? null) === f.id)) {
    return { kind: "machine", machine: f.id };
  }
  return { kind: "all" };
}

/** The agents that `r` (from resolveFilter) keeps; machineOf as for the lanes. */
export function applyFilter(list, r, machineOf) {
  if (r.space) return list.filter((a) => a.space === r.space.id);
  if (r.kind === "machine") return list.filter((a) => (machineOf(a) ?? null) === r.machine);
  return list;
}
