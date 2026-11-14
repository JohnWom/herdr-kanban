// The tabs with no agent, as the cards of the Terminals column: no Herdr call here, so it runs with made-up tabs too.

/** The column of the terminal cards; also their status, so the columns and the lanes take them as they take agents. */
export const TERMINALS = "terminals";

/** One card per tab of `spaces` that no agent of `agents` runs in; a tab whose panes are all mod panes is left out.
 *  The pane of a card is the focused terminal pane of its tab, else its first. `nameOf(space)`: the space name. */
export function terminalTabs(spaces, agents, panes, nameOf = (p) => p.name ?? "") {
  const busy = new Set(agents.map((a) => a.tab));
  const cards = [];
  for (const space of spaces) {
    (space.tabs ?? []).forEach((tab, i) => {
      if (busy.has(tab.id)) return;
      const own = panes.filter((p) => p.tab === tab.id), shells = own.filter((p) => p.terminal);
      if (own.length && !shells.length) return;
      const pane = shells.find((p) => p.focused) ?? shells[0] ?? null;
      // Not pinned and one seq for all: inColumn keeps them in the order of the spaces and their tabs.
      cards.push({ term: true, status: TERMINALS, pinned: false, seq: 0,
        space: space.id, space_name: nameOf(space), machine: space.machine ?? null, tab: tab.id, tab_name: String(tab.name ?? ""), place: i + 1,
        address: pane?.terminal ?? null, pane: pane?.pane ?? null, cwd: pane?.cwd ?? null, program: pane?.program ?? null, panes: own.length });
    });
  }
  return cards;
}
