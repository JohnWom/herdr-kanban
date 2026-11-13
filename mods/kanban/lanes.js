// The swimlanes of the board as plain data: no Herdr call here, so it runs with made-up agents too.

/** The id of the lane for agents whose space is not in spaces(). */
const OTHER = "other";

/** The cards of status `id`: pinned first, then the newest. */
export const inColumn = (list, id) => list.filter((a) => a.status === id)
  .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.seq - a.seq);

/** The lanes of `list` by "machine" or by "space", in the order they show; only lanes that hold an agent.
 *  A lane is { id, machine (null: this computer), space (null by machine and for OTHER), agents }.
 *  By machine: this computer first, then the machines in the order of `spaces`, then the machines
 *  with no space by name. By space: the order of `spaces` (this computer first, then the machines
 *  by name), then OTHER. */
export function groupLanes(list, by, spaces, machineOf) {
  const map = new Map();
  const add = (id, lane, a) => {
    if (!map.has(id)) map.set(id, { id, ...lane, agents: [] });
    map.get(id).agents.push(a);
  };
  if (by === "machine") {
    for (const a of list) {
      const machine = machineOf(a) ?? null;
      add(`machine:${machine ?? ""}`, { machine, space: null }, a);
    }
    // Follow spaces() so the machines keep the order they have by space.
    const first = new Map();
    for (const p of spaces) if (p.machine != null && !first.has(p.machine)) first.set(p.machine, first.size);
    const place = (g) => (g.machine === null ? -1 : first.get(g.machine) ?? first.size);
    return [...map.values()].sort((x, y) => place(x) - place(y)
      || String(x.machine).localeCompare(String(y.machine)));
  }
  const rank = new Map(spaces.map((p, i) => [p.id, i]));
  for (const a of list) {
    const space = rank.has(a.space) ? spaces[rank.get(a.space)] : null;
    if (space) add(`space:${space.id}`, { machine: space.machine ?? null, space }, a);
    else add(OTHER, { machine: null, space: null }, a);
  }
  const place = (g) => (g.space ? rank.get(g.space.id) : spaces.length);
  return [...map.values()].sort((x, y) => place(x) - place(y));
}

/** The addresses in reading order: lane by lane, column by column; the lanes in `folded` left out. */
export const laneOrder = (lanes, columns, folded) => lanes.filter((g) => !folded.has(g.id))
  .flatMap((g) => columns.flatMap((id) => inColumn(g.agents, id))).map((a) => a.address);
