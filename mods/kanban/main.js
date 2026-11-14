// Kanban for the Herdr app: every agent is a card in a column by status.
// One mod, parts chosen by props.part:
//   "bar"   the top bar: search, filter, grouping, New agent, gear, panel buttons, window buttons.
//   "board" the columns with the cards (the agents, and the tabs with no agent in Terminals); grouped, one swimlane
//           per machine or space under the column heads.
//   "tab-head" the head of the tab panel: the tab (or, in a tree of agents, the path to it), its space and
//              machine, the tree button, the maximize button.
//   "tree-menu" the agent tree of the shown agent, a popup (the tree button of the head opens it).
//   "panel-title" the title row of a panel dialog (the bar opens it, see openDialog).
//   "group-menu" the menu of a group button of the panel group, a popup (the bar opens it, see openGroup).
//   "clone-menu" the menu of the duplicate button of a card, a popup (the board opens it, see openClone).
//   "card-menu" the right-click menu of a card, a popup (the board opens it, see openCardMenu).
//   "card-rename" the field that renames the tab of a card, a popup (the card menu opens it, see openRename).
//   "new-dialog" the dialog that starts a session: machine, space, program, tab name (the bar and the card menu open it, see openNew).
//   "columns-menu" every column with a tick to show or hide it, a popup (the board opens it, see openColumns).
//   "filter-menu" what the board shows: all, the current space, a space or a machine, a popup (the bar opens it, see openFilter).
//   "place-menu" off, right, left or bottom: where the tab panel shows, a popup (the bar opens it, see openPlace).
//   "gear-menu" the menu of the gear button: the look of the board, the columns, Herdr's settings, Bar buttons and PowerMods,
//               a popup (the bar opens it, see openGear).
//   "buttons-menu" the editor of the order and the visibility of the panel buttons, a popup (the bar opens it, see openButtons).
// The parts share their state through shared(): hidden columns, search text, filter.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { agents, spaces, panes, machines, focused, layout, window, theme, props, shared, setShared, run, openOverlay, closeOverlay,
  setAgentOrder, appHome, home, terminals, readTextFile, watchFolder, notify, nextCommand, hc, knownAgents, exec } from "herdr";
import * as fs from "fs/promises";
import { icon, tint, iconButton, columnChip, segmented, searchBox, textField, pill, button, panelButton, menuArrow, panelGlyph, buttonGroup, divider, stop, machineChip, remoteColor } from "./ui.js";

/** The machine of a card on another computer: a terminal card has the machine of its space, an agent's address is
 *  "<machine>/<terminal>". */
const machineOf = (a) => (a?.term ? a.machine : String(a?.address ?? "").includes("/") ? a.address.split("/")[0] : null);
import { WaitingTracker } from "./waiting.js";
import { inColumn, groupLanes, laneOrder, placesOf, slotsOf, slotsWidth, nextCard } from "./lanes.js";
import { parseFilter, migrateFilter, resolveFilter, applyFilter } from "./filter.js";
import { pairsOf, stacks, barLook } from "./density.js";
import { TERMINALS, terminalTabs } from "./terminals.js";
import { PLACES, axis, placeOf, movePanel } from "./place.js";
import { forest, pathTo, flatten, step as treeStep } from "./tree.js";

/** The icon of an entry of knownAgents: a one-color glyph is tinted, anything else is a picture. */
const agentGlyph = (a, t) => (!a.icon ? svg(icon("bot")).size(15).flex_none().text_color(t.muted)
  : a.tint ? svg(a.icon).size(15).flex_none().text_color(a.color || t.foreground) : image(a.icon).size(15).flex_none());

const KEY_LANG = "herdr-mods.lang"; // the language of the whole kit, set in the mods-hub; absent: props.lang
const KEY_HIDDEN = "kanban.hidden"; // ids of the hidden columns
const KEY_WAITING = "kanban.waiting"; // "on" | "off"; absent: props.waiting (on unless it is false)
const KEY_DISMISSED = "kanban.waiting.dismissed"; // { "<terminal>": turn }: cards the person sent back to Done/Idle, for that turn
const KEY_QUERY = "kanban.query"; // the search text
const KEY_FILTER = "kanban.filter"; // { kind: "all" | "current" | "space" | "machine", id? } (see filter.js); absent: all
const OLD_SCOPE = "kanban.scope", OLD_SCOPE_SPACE = "kanban.scopeSpace"; // older versions; savedFilter() takes them over once
const KEY_MAXIMIZED = "kanban.maximized"; // px of the tab panel before it was maximized (maximized itself is board.hidden)
const KEY_PLACE = "kanban.panelPlace"; // "right" | "left" | "bottom": where the tab panel shows (see place.js); absent: right
const KEY_PANEL_SIZE = "kanban.panelSize"; // { side, bottom }: px of the tab panel at a side and at the bottom, saved on a move
const KEY_WIDTH = "kanban.width"; // widest a column may be, in px; absent: columns share the board
const KEY_ORDER = "kanban.order"; // ids of the columns, left to right; absent: the order of COLUMNS
const KEY_DENSITY = "kanban.density"; // the bar: "auto" | "compact" | "normal"; absent: auto. Shared with the Dock bar (tabs-dock)
const KEY_PAIRS = "kanban.pairs"; // the board: "auto" | "on" | "off"; absent: taken once from an older density (pairs())
const KEY_CARDS = "kanban.cards"; // "auto" | "summary" | "full"; absent: auto (summary while the board stacks its pairs)
const KEY_PANEL_OPEN = "kanban.panelOpen"; // "auto" | "side" | "dialog"; absent: auto. Shared with the Dock bar (tabs-dock)
const KEY_PANEL_DIALOG = "kanban.panelDialog"; // { id, panel }: the panel dialog that is open now; null: none
const KEY_GROUP = "kanban.group"; // "none" | "machine" | "space"; absent: none
const KEY_COLLAPSED = "kanban.collapsed"; // ids of the folded lanes: "machine:<name>" ("machine:" here), "space:<id>", "other"
// Where the panel buttons open their panel, set in the gear menu. The command kanban.panel-open goes auto -> side -> dialog -> auto.
// Auto opens a dialog when the bar is narrower than PANEL_NARROW px (a small monitor), else the side panel.
const PANEL_OPENS = ["auto", "side", "dialog"];
const PANEL_NARROW = 1600;
const DIALOG_TITLE = 36; // px: the title row of a panel dialog
// The dialogs opened since the app started. shared() is saved to disk, so after a restart KEY_PANEL_DIALOG can
// name a dialog that is gone: the bar trusts it only when its id is here. On globalThis, not in the module:
// a layout switch starts a new copy of the bar with a new module, and the dialog stays open.
const liveDialogs = () => (globalThis.__kanbanPanelDialogs ??= new Set());
// What Auto of "Stack columns" does on the board now ({ stacks }), for the gear menu and kanban.next / prev (the bar).
const boardNow = () => (globalThis.__kanbanBoard ??= {});
// The mods that the person turned off in the mods-hub: a list of mod folder names. The same key and the same rules
// as in mods/tabs-dock. The bar shows no button of an entry whose mod is off, hides the blocks of an off mod in its
// layout, and shows Herdr's own mod in a block of an off replacement mod (ORIGINALS). It undoes only what it did.
const KEY_OFF = "herdr-mods.disabled";
const ORIGINALS = { "space-deck": "spaces", "files-md": "files", "git-client": "changes" };
const offMods = () => { const v = shared(KEY_OFF); return new Set(Array.isArray(v) ? v.filter((n) => typeof n === "string") : []); };
// The mod of a panels.json entry: its `mod`, the mod of a "<mod>.<command>" or of a mod.open command.
const entryMod = (e) => e.mod ?? (e.run === "mod.open" ? e.args?.name : String(e.run ?? "").includes(".") ? String(e.run).split(".")[0] : null);
// Steps of the width control. null = Auto: the columns share the whole board.
const WIDTHS = [150, 180, 220, 260, 320, 400, null];
const MIN_COLUMN = 150; // narrowest a column may be before the board scrolls
const MIN_COLUMN_COMPACT = 120; // the same, on a compact board
const GAP = 12, GAP_COMPACT = 8; // between the columns
const STUB_W = 36; // px: a hidden column in the row of columns (see stub)

// The bar (density) and the board (pairs), set in the gear menu. Auto goes by the width of the part (on_size_change,
// the same px as .w()): the bar shows icons below BAR_WIDE and all names from LABELS_WIDE; the board stacks its pairs
// and turns compact below COLUMN_WIDE for each visible column (see density.js).
const DENSITIES = ["auto", "compact", "normal"];
const PAIRS = ["auto", "on", "off"];
// Card view, set in the gear menu.
const CARD_VIEWS = ["auto", "summary", "full"];
// Swimlanes, set in the bar; the icon of each choice.
const GROUPINGS = ["none", "machine", "space"];
const GROUP_ICONS = { none: "lanes-none", machine: "lanes-machine", space: "lanes-space" };
const BAR_WIDE = 1800;
const LABELS_WIDE = 2250; // from this bar width the panel buttons show their names, not only icons
const COLUMN_WIDE = 220;
// On a compact board the columns of a group share one place, one under the other, at the place of
// the first of them in the column order. Waiting goes under Working, Idle under Done.
const GROUPS = [["working", "waiting"], ["done", "idle"]];
// "Waiting" is not a status the Herdr app reports: the mod derives it for a Claude Code agent that shows
// as Done or Idle while background subagents or shell commands still run (see waiting.js). It has no theme color of its own.
const WAITING = "waiting";
const statusColor = (t, status) => (status === WAITING ? t.ansi5 || t.accent : status === TERMINALS ? t.muted : t[status] ?? t.idle);

// Left by older versions: a core terminal with this name and the label kanban.shell=1, and a terminal block
// "shell" in a column "board-main" with the board. The bar removes the block, and the terminal once it has ended (see migrate, endShell).
const OLD_SHELL = "kanban-shell";

// The tab panel ("detail"): its head (part "tab-head") over the active tab. Older versions had a block
// { agent: "focused" } here and a stack "view" with a Terminals view; migrate() swaps them for this.
const DETAIL_PX = 460, DETAIL_BOTTOM_PX = 360; // px: the tab panel at a side (its width), at the bottom (its height)
// The rows of the place menu: "off" hides the panel and keeps its place.
const PLACE_ROWS = ["off", ...PLACES];
const PLACE_ICONS = { off: "eye-off", right: "panel", left: "panel-left", bottom: "panel-bottom" };
const PLACE_W = 200; // px: the place menu
const MIGRATE_RENDERS = 20, MIGRATE_MS = 3000; // how long migrate() waits for its layout.set to land
const TAB_PANEL = [
  { id: "detail-head", type: "block", content: { mod: "kanban", props: { part: "tab-head" } }, size: { px: 36 } },
  { id: "detail-tab", type: "block", padding: 8, content: { tab: "active", pane: {
    header: { content: { mod: "pane" }, reveal: "always", height: 30, position: "top" },
    background: "background", border: { width: 1, color: "border" }, focus: { width: 1, color: "accent" }, radius: 10, gap: 8, lone: true } } },
];
// A tab nobody named is called by its place: "1", "2", ... (spaces() may give "tb<n>").
const unnamed = (name) => /^(tb)?\d+$/.test(String(name ?? "").trim());
/** The tab the panel shows: the active tab of the active space. */
function shownTab() {
  const space = spaces().find((p) => p.active), tab = space?.tabs.find((x) => x.active) ?? null;
  return { space, tab, id: tab?.id ?? focused()?.tab ?? null };
}

// The side panel of the layout (node "panel", stack "panel-body"): Herdr's own Files and Changes mods.
const PANELS = [
  { id: "files", label: "Files", icon: icon("files") },
  { id: "changes", label: "Changes", icon: icon("changes"), group: "git" },
];
// The groups of panel buttons: the panels with the same `group` share one button, and a click on it opens a menu
// with the full name of each panel. A group that is not here uses its id as its name and the icon of its first panel.
// The same as GROUPS in mods/tabs-dock.
const PANEL_GROUPS = { git: { label: "Git", icon: icon("git") } };
const MENU_W = 220, MENU_PAD = 5, MENU_HEAD = 26, MENU_ROW = 32; // px: the menu of a group button (and of the columns)
const FILTER_W = 260, FILTER_MAX = 440; // px: the filter menu (its width, the tallest it gets before it scrolls)
const CLONE_W = 270; // px: the menu of the duplicate button of a card
const CARD_MENU_W = 250; // px: the right-click menu of a card
const TREE_W = 300, TREE_ROWS = 12, TREE_INDENT = 16; // px, rows: the tree menu (it scrolls past TREE_ROWS)
const RENAME_W = 300, RENAME_ROW = 40; // px: the rename popup (its width and its field row)
// px: the New session dialog (its size, a row of a list, a field row, the head and the foot). Its two lists
// share the height that is left, so the size does not follow the number of spaces or agents.
const NEW_W = 440, NEW_H = 520, NEW_ROW = 30, NEW_FIELD = 36, NEW_HEAD = 34, NEW_FOOT = 48;
const EDIT_W = 280, EDIT_FOOT = 38; // px: the editor of the bar buttons (its width and its Reset row)
const GEAR_W = 340, GEAR_ROW = 38, GEAR_HINT = 22, GEAR_SEP = 9; // px: the gear menu (a row with a control, the order hint, the line)

// The order of the panel buttons and the buttons that the bar hides, shared with the Dock bar (the same key and the
// same rules as in mods/tabs-dock): { order: [button id], hidden: [button id] }. A button id is the id of a panel or
// an entry, or "group-<group>" for a group button. The buttons that are not in `order` (a new entry of panels.json)
// come after the others, in the order of the file. Absent: the order of the file, no button hidden.
const KEY_BUTTONS = "kanban.barButtons";
const buttonId = (it) => (it.members ? `group-${it.group}` : it.id);
function barButtons() {
  const v = shared(KEY_BUTTONS), list = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string") : []);
  return { order: list(v?.order), hidden: list(v?.hidden) };
}
// The items (anything with an `id`) in the order of `order`; the others after them, in their own order.
function arrange(items, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items.map((it, i) => ({ it, i, r: rank.get(it.id) ?? order.length + i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.it);
}

// The duplicate of an agent starts a new session: these flags continue an old one, so the clone drops them
// (with their value, when they have one). The same lists as `drop` in the agent-resume hook.
// An agent that is not here drops only --resume and --continue.
const SESSION_FLAGS = {
  claude: ["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session", "--from-pr"],
  agy: ["--continue", "-c", "--conversation"],
  opencode: ["--continue", "-c", "--session", "-s"],
  codex: ["--last"],
};
const SESSION_DEFAULT = ["--resume", "--continue"];

/** The arguments of `agent` without the flags that continue a session. `codex resume <id>` loses "resume" and the id. */
function freshArgs(agent, args) {
  const drop = new Set(SESSION_FLAGS[agent] ?? SESSION_DEFAULT);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i], next = args[i + 1];
    const value = next !== undefined && !next.startsWith("-");
    if (agent === "codex" && i === 0 && (tok === "resume" || tok === "fork")) { if (value) i++; continue; }
    if (drop.has(tok.split("=")[0])) { if (!tok.includes("=") && value) i++; continue; }
    out.push(tok);
  }
  return out;
}

/** The argv that starts a new session of the agent in terminal `address`, or null when it is not known.
 *  First the labels of the agent-resume mod: resume.agent (the command) and resume.args (the flags it started
 *  with). The terminal's own argv is the shell the agent runs in, so it cannot tell. Else the command of the
 *  program in the list of known agents, with no arguments. */
async function cloneArgv(address, programKey, machine) {
  let labels = {};
  try { labels = JSON.parse((await hc(["get", address, "--json"]))?.stdout ?? "")?.labels ?? {}; } catch {}
  const agent = String(labels["resume.agent"] ?? "");
  if (/^[\w.-]+$/.test(agent)) return [agent, ...freshArgs(agent, String(labels["resume.args"] ?? "").split(/\s+/).filter(Boolean))];
  let list = [];
  try { list = await knownAgents({ on: machine ?? null }); } catch {}
  const known = list.find((k) => k.key === programKey && Array.isArray(k.run) && k.run.length);
  return known ? [known.run[0], ...freshArgs(known.key, known.run.slice(1))] : null;
}

// The default order: needs you, working, waiting, done, idle, then the tabs with no agent. The arrows in a column
// header change it, and shared(KEY_ORDER) keeps the new order.
const COLUMNS = [
  { id: "blocked", symbol: "bell" },
  { id: "working", symbol: "zap" },
  { id: WAITING, symbol: "hourglass" },
  { id: "done", symbol: "check" },
  { id: "idle", symbol: "moon" },
  { id: TERMINALS, symbol: "terminal" },
];

const STR = {
  en: {
    search: "Search agents…",
    idle: "Idle", blocked: "Needs you", working: "Working", done: "Done", waiting: "Waiting", terminals: "Terminals",
    subagents: (n) => (n === 1 ? "1 subagent" : `${n} subagents`),
    commands: (n) => (n === 1 ? "1 command" : `${n} commands`),
    waitingOn: "Waiting column on: agents that wait for subagents or background commands get their own column. Click to turn it off.",
    waitingOff: "Waiting column off: those agents show as Done or Idle. Click to turn it on.",
    notWaiting: "Not waiting: show it as Done or Idle",
    agents: (n) => (n === 1 ? "1 agent" : `${n} agents`),
    filterAll: "All", filterCurrent: "Current space", filterSpaces: "Spaces", filterMachines: "Machines",
    filterAllTip: "Showing every agent. Click to choose a space or a machine.",
    filterCurrentTip: "Showing the space you are in: {name}. It follows the active space. Click to change.",
    filterOnlyTip: "Showing only {name}. Click to change.",
    detailOn: "Hide the tab panel", detailOff: "Show the tab panel", agentLabel: "Agent",
    placeTip: "Where the tab panel shows", place_off: "Off", place_right: "Right", place_left: "Left", place_bottom: "Bottom",
    maximize: "Maximize the panel: hide the board", restore: "Restore the board", menuMaximize: "Open maximized",
    tabNumber: "Tab {n}", noTab: "No tab open: click a card",
    treeTitle: "Agent tree", treeTip: (v) => `Agent tree: ${v.n} agents`, treeKids: (n) => `${n} ${n === 1 ? "child" : "children"}`,
    treePeek: "No pane: opens a peek", treeHere: "Shown now", treeBetween: "Between the top and here",
    treeBetweenTip: (n) => `${n} ${n === 1 ? "agent" : "agents"} in between`,
    newAgent: "New agent", hide: "Hide this column", showCol: "Show {name}", hideCol: "Hide {name}",
    emptyCol: "No agents here", emptyTerminals: "No tab without an agent", emptyColSearch: "No match",
    allHidden: "All columns are hidden", allHiddenHint: "Click a column above to show its cards.", showAll: "Show all columns",
    none: "No agents yet", noneHint: "Start an agent with the New agent button. It appears here as a card, and moves between columns when its status changes.",
    pin: "Pin to the top of its column", unpin: "Unpin",
    now: "just now", min: "{n} min ago", hour: "{n} h ago", day: "{n} d ago",
    gearTitle: "Settings", gearHerdr: "Herdr settings", gearMods: "PowerMods",
    gearButtons: "Bar buttons", buttonsTitle: "Bar buttons (top of the list = left)", moveUp: "Move up", moveDown: "Move down",
    hideButton: "Hide in the bar", showButton: "Show in the bar", resetButtons: "Reset",
    settingsTip: "Open the settings", panelTip: "Show or hide {name}",
    auto: "Auto", widthTip: "Column width: {w}. Use − and + to change it.",
    toAuto: "Set Auto: the columns share the whole board",
    widthAutoTip: "Click the value to go back to Auto.",
    narrower: "Narrower columns", wider: "Wider columns",
    moveLeft: "Move this column left", moveRight: "Move this column right",
    density_auto: "Auto", density_compact: "Icons", density_normal: "Names",
    densityNowIcons: "{mode}: icons now (names from {px} px of bar)", densityNowNames: "{mode}: names now",
    densityNowMixed: "{mode}: names now, the panel buttons as icons (their names from {labels} px)",
    pairs_auto: "Auto", pairs_on: "On", pairs_off: "Off",
    pairsOn: "Waiting under Working, Idle under Done, with smaller heads and cards",
    pairsNowOn: "{mode}: stacked now (below {px} px per column)", pairsNowOff: "{mode}: side by side now (stacks below {px} px per column)",
    pairsAuto: "{mode}: stacks below {px} px per column",
    cards_auto: "Auto", cards_summary: "Summary", cards_full: "Full",
    cardsAuto: "Auto (summary while the columns are stacked)",
    widthLabel: "Column width", densityLabel: "Bar", pairsLabel: "Stack columns", cardsLabel: "Cards", waitingLabel: "Waiting column",
    columnsTitle: "Columns", orderHint: "The arrows in a column header change the order.",
    opens_auto: "Auto", opens_side: "Side panel", opens_dialog: "Dialog",
    opensNowDialog: "{mode} (dialog now)", opensNowSide: "{mode} (side panel now)",
    opensLabel: "Panels open in",
    toSide: "Open in the side panel", toTab: "Open in a tab", closeDialog: "Close",
    rename: "Rename the tab", duplicate: "Duplicate this agent", cloneHere: "Duplicate in this space", cloneWorktree: "Duplicate in a new worktree…",
    cloneTitle: "Duplicate {name}", cloneFail: "Kanban: duplicate", noCommand: "The command of this agent is not known.",
    menuRename: "Rename the tab…", menuClose: "Close the tab", menuCloseWith: "Close the tab ({what})",
    menuCloseTip: "Closes every pane of the tab. Herdr asks first when it is the last tab of its space.",
    panes: (n) => (n === 1 ? "1 pane" : `${n} panes`), cardFail: "Kanban: the command failed",
    renameTitle: "Rename the tab", renameEmpty: "Empty: its number again", cancel: "Cancel", save: "Save",
    menuNewHere: "New session here…",
    newTitle: "New session", newMachine: "Machine", thisComputer: "This computer",
    newUnreachable: "{name} cannot be reached now",
    newSpaceLabel: "Space", newSpaceRow: "New space…", newSpaceHint: "Name of the space (optional)",
    newNoSpaces: "No space on this machine yet",
    newWhatLabel: "What to start", newTerminal: "Terminal", newTerminalTip: "A shell: the default of the machine",
    newLoading: "Looking for agents…", newNoAgents: "No agent found on this machine",
    newTabLabel: "Tab name", newTabHint: "Optional", newStart: "Start",
    group_none: "One board, no lanes", group_machine: "A lane per machine", group_space: "A lane per space", other: "Other",
  },
  pt: {
    search: "Buscar agentes…",
    idle: "Ociosos", blocked: "Precisam de você", working: "Trabalhando", done: "Concluídos", waiting: "Aguardando", terminals: "Terminais",
    subagents: (n) => (n === 1 ? "1 subagente" : `${n} subagentes`),
    commands: (n) => (n === 1 ? "1 comando" : `${n} comandos`),
    waitingOn: "Coluna Aguardando ligada: agentes que esperam subagentes ou comandos em segundo plano ganham uma coluna própria. Clique para desligar.",
    waitingOff: "Coluna Aguardando desligada: esses agentes aparecem como Concluídos ou Ociosos. Clique para ligar.",
    notWaiting: "Não está esperando: mostrar como Concluído ou Ocioso",
    agents: (n) => (n === 1 ? "1 agente" : `${n} agentes`),
    filterAll: "Todos", filterCurrent: "Espaço atual", filterSpaces: "Espaços", filterMachines: "Máquinas",
    filterAllTip: "Mostrando todos os agentes. Clique para escolher um espaço ou uma máquina.",
    filterCurrentTip: "Mostrando o espaço em que você está: {name}. Segue o espaço ativo. Clique para mudar.",
    filterOnlyTip: "Mostrando só {name}. Clique para mudar.",
    detailOn: "Ocultar o painel da aba", detailOff: "Mostrar o painel da aba", agentLabel: "Agente",
    placeTip: "Onde o painel da aba aparece", place_off: "Desligado", place_right: "Direita", place_left: "Esquerda", place_bottom: "Embaixo",
    maximize: "Maximizar o painel: ocultar o quadro", restore: "Restaurar o quadro", menuMaximize: "Abrir maximizado",
    tabNumber: "Aba {n}", noTab: "Nenhuma aba aberta: clique num cartão",
    treeTitle: "Árvore de agentes", treeTip: (v) => `Árvore de agentes: ${v.n} agentes`, treeKids: (n) => `${n} ${n === 1 ? "filho" : "filhos"}`,
    treePeek: "Sem painel: abre uma espiada", treeHere: "Mostrado agora", treeBetween: "Entre o topo e aqui",
    treeBetweenTip: (n) => `${n} ${n === 1 ? "agente" : "agentes"} no meio`,
    newAgent: "Novo agente", hide: "Ocultar esta coluna", showCol: "Mostrar {name}", hideCol: "Ocultar {name}",
    emptyCol: "Nenhum agente aqui", emptyTerminals: "Nenhuma aba sem agente", emptyColSearch: "Nada encontrado",
    allHidden: "Todas as colunas estão ocultas", allHiddenHint: "Clique numa coluna acima para mostrar os cartões dela.", showAll: "Mostrar todas as colunas",
    none: "Nenhum agente ainda", noneHint: "Inicie um agente com o botão Novo agente. Ele aparece aqui como um cartão e muda de coluna quando o status muda.",
    pin: "Fixar no topo da coluna", unpin: "Desafixar",
    now: "agora", min: "há {n} min", hour: "há {n} h", day: "há {n} d",
    gearTitle: "Configurações", gearHerdr: "Configurações do Herdr", gearMods: "PowerMods",
    gearButtons: "Botões da barra", buttonsTitle: "Botões da barra (topo da lista = esquerda)", moveUp: "Mover para cima",
    moveDown: "Mover para baixo", hideButton: "Ocultar na barra", showButton: "Mostrar na barra", resetButtons: "Restaurar",
    settingsTip: "Abrir as configurações", panelTip: "Mostrar ou ocultar {name}",
    auto: "Auto", widthTip: "Largura da coluna: {w}. Use − e + para mudar.",
    toAuto: "Voltar para Auto: as colunas dividem o quadro todo",
    widthAutoTip: "Clique no valor para voltar para Auto.",
    narrower: "Colunas mais estreitas", wider: "Colunas mais largas",
    moveLeft: "Mover esta coluna para a esquerda", moveRight: "Mover esta coluna para a direita",
    density_auto: "Auto", density_compact: "Ícones", density_normal: "Nomes",
    densityNowIcons: "{mode}: ícones agora (nomes a partir de {px} px de barra)", densityNowNames: "{mode}: nomes agora",
    densityNowMixed: "{mode}: nomes agora, os botões de painel como ícones (seus nomes a partir de {labels} px)",
    pairs_auto: "Auto", pairs_on: "Sim", pairs_off: "Não",
    pairsOn: "Aguardando sob Trabalhando, Ociosos sob Concluídos, com cabeçalhos e cartões menores",
    pairsNowOn: "{mode}: empilhadas agora (abaixo de {px} px por coluna)", pairsNowOff: "{mode}: lado a lado agora (empilha abaixo de {px} px por coluna)",
    pairsAuto: "{mode}: empilha abaixo de {px} px por coluna",
    cards_auto: "Auto", cards_summary: "Resumido", cards_full: "Completo",
    cardsAuto: "Auto (resumido enquanto as colunas estão empilhadas)",
    widthLabel: "Largura da coluna", densityLabel: "Barra", pairsLabel: "Empilhar colunas", cardsLabel: "Cartões", waitingLabel: "Coluna Aguardando",
    columnsTitle: "Colunas", orderHint: "As setas no cabeçalho de uma coluna mudam a ordem.",
    opens_auto: "Auto", opens_side: "Painel lateral", opens_dialog: "Diálogo",
    opensNowDialog: "{mode} (diálogo agora)", opensNowSide: "{mode} (painel lateral agora)",
    opensLabel: "Painéis abrem em",
    toSide: "Abrir no painel lateral", toTab: "Abrir numa aba", closeDialog: "Fechar",
    rename: "Renomear a tab", duplicate: "Duplicar este agente", cloneHere: "Duplicar neste espaço", cloneWorktree: "Duplicar num novo worktree…",
    cloneTitle: "Duplicar {name}", cloneFail: "Kanban: duplicar", noCommand: "O comando deste agente não é conhecido.",
    menuRename: "Renomear a aba…", menuClose: "Fechar a aba", menuCloseWith: "Fechar a aba ({what})",
    menuCloseTip: "Fecha todos os painéis da aba. O Herdr pergunta antes quando é a última aba do espaço.",
    panes: (n) => (n === 1 ? "1 painel" : `${n} painéis`), cardFail: "Kanban: o comando falhou",
    renameTitle: "Renomear a aba", renameEmpty: "Vazio: volta ao número", cancel: "Cancelar", save: "Salvar",
    menuNewHere: "Nova sessão aqui…",
    newTitle: "Nova sessão", newMachine: "Máquina", thisComputer: "Este computador",
    newUnreachable: "{name} não pode ser acessada agora",
    newSpaceLabel: "Espaço", newSpaceRow: "Novo espaço…", newSpaceHint: "Nome do espaço (opcional)",
    newNoSpaces: "Nenhum espaço nesta máquina ainda",
    newWhatLabel: "O que iniciar", newTerminal: "Terminal", newTerminalTip: "Um shell: o padrão da máquina",
    newLoading: "Procurando agentes…", newNoAgents: "Nenhum agente encontrado nesta máquina",
    newTabLabel: "Nome da aba", newTabHint: "Opcional", newStart: "Iniciar",
    group_none: "Um quadro, sem raias", group_machine: "Uma raia por máquina", group_space: "Uma raia por espaço", other: "Outros",
  },
};

// The buttons of dock/panels.json (the same file the Dock layout reads). Entry:
//   { id, label, icon, mod, props?, opens?: "panel" | "tab" | "command", name?, run?, args?, group? }
//   "panel" (default): a block of the side panel, added to this layout by this bar.
//   "tab": a tab per space with `mod` as its only pane.
//   "command": runs a Herdr command (`run`, `args`).
//   group: the entries with the same group share one button (see PANEL_GROUPS). "git" puts it with Changes.
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ids = (node, out = new Set()) => {
  if (node?.id) out.add(node.id);
  for (const child of node?.children ?? []) ids(child, out);
  return out;
};

// One tab per space for this mod: focus it if it exists, otherwise create it.
function showTab(mod, name) {
  const active = spaces().find((p) => p.active);
  const tabIds = new Set(active?.tabs.map((tab) => tab.id) ?? []);
  const open = panes().find((pane) => pane.mod === mod && tabIds.has(pane.tab));
  if (open) {
    const zoomed = panes().find((pane) => pane.tab === open.tab && pane.zoomed);
    if (zoomed && zoomed.pane !== open.pane) run("pane.zoom", { pane: zoomed.pane });
    return run("pane.focus", { pane: open.pane });
  }
  return run("tab.new", { name, mod });
}

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));
const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
};
// The node that shows and hides the side panel: the column "panel" around the stack "panel-body". When a block
// leaves the layout (a terminal block, when its terminal ends), Herdr removes each column that keeps only
// one child, and "panel" is one of them. Then the stack itself is the panel.
const sidePanel = (root) => find(root, "panel") ?? find(root, "panel-body");
// The name of a layout file as a button label: "main-dock" -> "Main dock".
const layoutLabel = (name) => { const s = String(name).replace(/[-_]+/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
// The panel buttons in the order of the bar, with the entries of a group put together: an item stays as it is,
// and the first entry of a group becomes { group, members: [entry, ...] } in its place. The same as in mods/tabs-dock.
function foldGroups(items) {
  const out = [], seen = new Map();
  for (const it of items) {
    if (!it.group) { out.push(it); continue; }
    let g = seen.get(it.group);
    if (!g) { g = { group: it.group, members: [] }; seen.set(it.group, g); out.push(g); }
    g.members.push(it);
  }
  return out;
}
const base = (p) =>String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
/** The name of a space as Herdr shows it; "" for none. */
const MARK_W = 16; // px: the status mark at the end of a card's first row
/** About how wide machineChip() draws `name` (an icon, the name at 10.5 px, its padding). */
const machineChipW = (name) => Math.min(160, 31 + String(name).length * 6.5);
const spaceName = (p) => (p ? p.name || base(p.folder) || p.id : "");

/** The lines `s` takes at `cpl` characters a line, wrapping at spaces; a word longer than a line breaks. */
function linesOf(s, cpl) {
  let n = 1, used = 0;
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const w = word.length;
    if (used && used + 1 + w <= cpl) { used += 1 + w; continue; }
    if (used) { n++; used = 0; }
    n += Math.ceil(w / cpl) - 1;
    used = w % cpl || cpl;
  }
  return n;
}

/** Fits `text` into `lines` lines of `width` px: the largest size from `max` down to `min` (0.5 px
 *  steps) at which it wraps into that many lines, else `min` with the text cut (at a word when one
 *  ends near) and "…". GPUI can neither measure text nor clamp lines from a script, so the width of a
 *  character is an estimate (Geist, on the safe side). `width` null: `max`, text as is. */
function fitText(text, width, { max, min, lines = 1, bold = false }) {
  const s = String(text ?? "").trim();
  if (!s || typeof width !== "number" || width <= 0) return { size: max, text: s };
  const cplAt = (size) => Math.max(1, Math.floor(width / (size * (bold ? 0.6 : 0.55))));
  for (let size = max; size >= min; size -= 0.5) {
    if (linesOf(s, cplAt(size)) <= lines) return { size, text: s };
  }
  const cpl = cplAt(min);
  let cut = s.slice(0, Math.max(1, cpl * lines - 1));
  while (cut.length > 1 && linesOf(`${cut}…`, cpl) > lines) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(" ");
  if (space > cut.length * 0.6) cut = cut.slice(0, space);
  return { size: min, text: `${cut.trimEnd()}…` };
}

export default class Kanban extends View {
  init(given, cx) {
    // Read props once and keep them: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    const overlays = ["panel-title", "group-menu", "clone-menu", "card-menu", "card-rename", "new-dialog", "columns-menu", "filter-menu",
      "place-menu", "gear-menu", "buttons-menu", "tree-menu"];
    this.part = ["bar", "tab-head", ...overlays].includes(this.props.part) ? this.props.part : "board";
    if (this.part === "tab-head") return;
    if (overlays.includes(this.part)) {
      this.overlay = this.props.overlay ?? props()?.overlay;
      if (this.part === "panel-title") this.takeKeys(cx);
      if (this.part === "card-rename") this.takeName(cx);
      if (this.part === "new-dialog") this.takeNew(cx);
      return;
    }
    this.pairs(); // takes over an older density before the bar can change it, even when the board does not render
    // Which Claude Code agents wait for subagents. Both parts run one: they count the cards too.
    const minutes = Number(this.props.waitingMinutes);
    this.tracker = new WaitingTracker({ hc, home, exec, dirs: this.props.claudeDirs, ttlMs: minutes > 0 ? minutes * 60000 : undefined });
    this.waitSig = null;
    this.waitBusy = false;
    // The pencil of a card opens the tab-namer dialog, when that mod is installed.
    this.namer = false;
    const findNamer = (cx) => cx.spawn(async (cx) => {
      let found = false;
      try { found = Boolean(await readTextFile(`${appHome()}/mods/tab-namer/mod.json`)); } catch {}
      if (found !== this.namer) { this.namer = found; cx.notify(); }
    });
    findNamer(cx);
    cx.timer.every(60000, (cx) => findNamer(cx));
    if (this.part === "bar") {
      this.query = InputState.new({ placeholder: this.s("search"), value: String(shared(KEY_QUERY) ?? "") });
      this.query.on("change", () => setShared(KEY_QUERY, this.query.value()));
      this.entries = []; // the buttons of dock/panels.json
      this.groups = new Map(); // group id -> its panels, from the last render: the menu of a group button lists them
      this.loaded = false;
      this.version = 0;
      this.lastTry = null;
      this.injected = new Set();
      try { this.injected = new Set(JSON.parse(localStorage.getItem("kanban.injected") ?? "[]")); } catch {}
      // The blocks that this bar hid or swapped for an off mod: { "<layout>|<block id>": "<mod>" }.
      this.kitOff = {};
      try { this.kitOff = JSON.parse(localStorage.getItem("kanban.kitOff") ?? "{}") ?? {}; } catch {}
      cx.spawn(async () => this.endShell());
      const dir = `${appHome()}/dock`;
      cx.spawn(async (cx) => {
        try { await fs.mkdir(dir, { recursive: true }); } catch {}
        await this.loadEntries(cx);
        // The file is the whole interface: a save shows up in the bar at once.
        for (;;) {
          try { await watchFolder(dir); } catch { return; }
          await this.loadEntries(cx);
        }
      });
      // "kanban.panel-open" steps where the panels open, auto -> side -> dialog. "kanban.panel-<id>" opens or
      // closes the panel <id> (files, changes, or an id of dock/panels.json), as its button does.
      // "kanban.group-<id>" opens the menu of a group button (kanban.group-git). "kanban.gear" does what the
      // gear button does. "kanban.buttons" opens the editor of the bar buttons. "kanban.maximize" maximizes
      // the tab panel or restores the board. "kanban.group" steps the lanes: none -> machine -> space.
      // "kanban.filter" steps the filter: all -> the current space -> all. "kanban.pairs" steps Stack columns: auto -> on -> off.
      // "kanban.place" moves the tab panel: right -> bottom -> left -> right (and shows it). "kanban.place-off" hides it
      // (setPlace "off" of another copy). "kanban.next" / "kanban.prev" select the next / previous card, as a click does.
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = String(await nextCommand());
          if (cmd === "panel-open") this.stepPanelOpen();
          else if (cmd === "gear") this.openGear();
          else if (cmd === "buttons") this.openButtons();
          else if (cmd === "maximize") this.toggleMaximize();
          else if (cmd === "group") this.stepGroup();
          else if (cmd === "filter") this.stepFilter();
          else if (cmd === "pairs") this.stepPairs();
          else if (cmd === "place") this.stepPlace();
          else if (cmd === "place-off") this.setPlace("off");
          else if (cmd === "next") this.stepCard(1);
          else if (cmd === "prev") this.stepCard(-1);
          else if (cmd === "tree") this.openTree();
          else if (cmd.startsWith("tree-")) this.stepTree(cmd.slice(5));
          else if (cmd.startsWith("group-")) this.openGroup(cmd.slice(6));
          else if (cmd.startsWith("panel-")) this.togglePanel(cmd.slice(6));
          cx.notify();
        }
      });
    } else {
      cx.timer.every(30000, (cx) => cx.notify()); // keeps "3 min ago" fresh
    }
    // The subagents run on their own: look again now and then at the agents known to wait, so a
    // limit of time or a lost session cannot keep a card here for good.
    cx.timer.every(30000, (cx) => {
      if (this.waitingOn() && this.tracker.waits.size) this.syncWaiting(cx, true);
    });
  }

  /** The language: the kit setting `herdr-mods.lang` when it is set, else the `lang` prop, else English. */
  get lang() {
    const kit = shared(KEY_LANG);
    return STR[kit] ? kit : STR[this.props?.lang] ? this.props.lang : "en";
  }

  s(key, vars) {
    const v = STR[this.lang][key] ?? key;
    return typeof v === "function" ? v(vars) : fill(v, vars);
  }

  // ---- state ---------------------------------------------------------------

  hidden() {
    const list = shared(KEY_HIDDEN);
    return new Set(Array.isArray(list) ? list : []);
  }

  toggleColumn(id) {
    const set = this.hidden();
    if (set.has(id)) set.delete(id); else set.add(id);
    setShared(KEY_HIDDEN, [...set]);
  }

  /** All the columns, left to right. Waiting is one of them only while the feature is on. A saved order
   *  keeps only known ids; a column it does not list goes right after the column that comes before it
   *  in COLUMNS (so Waiting lands under Working for a person who saved an order before it existed),
   *  Terminals at the end. */
  columns() {
    const known = COLUMNS.filter((c) => c.id !== WAITING || this.waitingOn());
    const saved = shared(KEY_ORDER);
    const order = Array.isArray(saved) ? saved.filter((id, i) => known.some((c) => c.id === id) && saved.indexOf(id) === i) : [];
    known.forEach((c, i) => {
      if (order.includes(c.id)) return;
      if (c.id === TERMINALS) { order.push(c.id); return; }
      const before = known.slice(0, i).reverse().find((p) => order.includes(p.id));
      order.splice(before ? order.indexOf(before.id) + 1 : 0, 0, c.id);
    });
    return order.map((id) => known.find((c) => c.id === id));
  }

  /** The toggles of the gear menu and the columns menu: each column, shown or not, its card count from `counts`. */
  columnToggles(counts = {}) {
    const hidden = this.hidden();
    return this.columns().map((c) => {
      const on = !hidden.has(c.id), name = this.s(c.id);
      return { c, on, name, count: counts[c.id] ?? 0, tooltip: this.s(on ? "hideCol" : "showCol", { name }), flip: () => this.toggleColumn(c.id) };
    });
  }

  /** The card count of each column now, for the menus that list the columns. */
  columnCounts() {
    const shown = this.visible();
    return Object.fromEntries(COLUMNS.map((c) => [c.id, shown.filter((a) => a.status === c.id).length]));
  }

  // ---- agents that wait for subagents --------------------------------------------

  /** The Waiting column: on unless the person turned it off (the Waiting line in the gear menu, saved in
   *  shared) or the layout says `"waiting": false` in the props of the block. Off, every agent shows as
   *  its Herdr status says and the mod reads no transcript. */
  waitingOn() {
    const v = shared(KEY_WAITING);
    return v === "on" || v === "off" ? v === "on" : this.props.waiting !== false;
  }

  toggleWaiting() { setShared(KEY_WAITING, this.waitingOn() ? "off" : "on"); }

  /** The agents with the status the board shows: a Claude Code agent that is Done or Idle while its
   *  subagents run gets "waiting" and `wait` ({ count, items }). The answer counts only for the turn
   *  it was read in: when the agent works again it is stale and the card goes back at once. A hidden
   *  Waiting column counts as off, so the card stays in Done or Idle and does not leave the board. */
  withWaiting(list) {
    if (!this.waitingOn() || this.hidden().has(WAITING) || !this.tracker.waits.size) return list;
    const turns = new Map(terminals().map((x) => [x.address, x.turn]));
    const dismissed = shared(KEY_DISMISSED) ?? {};
    return list.map((a) => {
      const w = a.status === "done" || a.status === "idle" ? this.tracker.waits.get(a.address) : null;
      return w && w.turn === turns.get(a.address) && dismissed[a.address] !== w.turn ? { ...a, status: WAITING, wait: w } : a;
    });
  }

  /** The person says this agent does not wait (Claude Code can leave a finished subagent marked as
   *  waiting): the card goes back to Done or Idle until the agent takes another turn. */
  dismissWaiting(a) {
    setShared(KEY_DISMISSED, { ...(shared(KEY_DISMISSED) ?? {}), [a.address]: a.wait.turn });
  }

  /** Looks at the Claude Code agents that show as Done or Idle, when one of them changed turn. It runs
   *  off the render and asks for another one when the answer changes. `again`: read the transcripts
   *  of the agents known to wait once more, even if their turn is the same (the timer does). */
  syncWaiting(cx, again = false) {
    if (!this.waitingOn()) { this.waitSig = null; return; }
    const turns = new Map(terminals().map((x) => [x.address, x.turn]));
    const candidates = agents().filter((a) => a.app === "claude-code" && (a.status === "done" || a.status === "idle"))
      .map((a) => ({ address: a.address, turn: turns.get(a.address), cwd: panes().find((p) => p.pane === a.pane)?.cwd ?? null }));
    const sig = candidates.map((c) => `${c.address}:${c.turn}`).join("|");
    if (sig === this.waitSig && !again) return;
    if (this.waitBusy) { this.waitSig = null; return; } // look again on the next render
    this.waitSig = sig;
    this.waitBusy = true;
    const recheck = again ? new Set(this.tracker.waits.keys()) : new Set();
    cx.spawn(async (cx) => {
      let changed = false;
      try { changed = await this.tracker.refresh(candidates, Date.now(), recheck); } catch {}
      this.waitBusy = false;
      if (changed) cx.notify();
      if (this.waitSig === null) this.syncWaiting(cx); // an agent changed turn while this one read
    });
  }

  /** The visible column next to `id` in direction `dir` (-1 left, +1 right), or null at the edge. */
  neighbor(id, dir) {
    const hidden = this.hidden();
    const shown = this.columns().filter((c) => !hidden.has(c.id));
    return shown[shown.findIndex((c) => c.id === id) + dir]?.id ?? null;
  }

  /** Swaps column `id` with the visible column next to it. Hidden columns keep their place. */
  moveColumn(id, dir) {
    const other = this.neighbor(id, dir);
    if (!other) return;
    const order = this.columns().map((c) => c.id);
    const a = order.indexOf(id), b = order.indexOf(other);
    [order[a], order[b]] = [order[b], order[a]];
    setShared(KEY_ORDER, order);
  }

  /** The saved filter; the first read takes over the keys of older versions and clears them. */
  savedFilter() {
    const f = parseFilter(shared(KEY_FILTER));
    if (f) return f;
    const old = shared(OLD_SCOPE), oldSpace = shared(OLD_SCOPE_SPACE);
    if (old == null && oldSpace == null) return { kind: "all" };
    const next = migrateFilter(old, oldSpace);
    setShared(KEY_FILTER, next);
    setShared(OLD_SCOPE, null);
    setShared(OLD_SCOPE_SPACE, null);
    return next;
  }

  /** What the filter keeps now (see resolveFilter): a space or machine that is gone keeps all. */
  activeFilter() { return resolveFilter(this.savedFilter(), spaces(), this.machineRow()); }

  /** The command kanban.filter: all -> the current space -> all. */
  stepFilter() { setShared(KEY_FILTER, { kind: this.activeFilter().kind === "all" ? "current" : "all" }); }

  /** How the board splits into lanes: "none", "machine" or "space". */
  grouping() {
    const g = shared(KEY_GROUP);
    return GROUPINGS.includes(g) ? g : "none";
  }

  stepGroup() { setShared(KEY_GROUP, GROUPINGS[(GROUPINGS.indexOf(this.grouping()) + 1) % GROUPINGS.length]); }

  /** The lanes of `shown` in the columns `ids`, or null without lanes. Only the cards of those columns, so a lane
   *  with none of them goes away. */
  lanes(shown, ids) {
    const by = this.grouping();
    return by === "none" ? null : groupLanes(shown.filter((a) => ids.includes(a.status)), by, spaces(), machineOf);
  }

  /** The places of the board for the columns `cols`; `stacked`: Working with Waiting, Done with Idle share one. */
  places(cols, stacked) { return placesOf(cols, stacked ? GROUPS : []); }

  /** The cards in the order they show: place by place (top to bottom in one); the cards of a folded lane left out. */
  cardOrder(shown, places, lanes = this.lanes(shown, places.flat().map((c) => c.id))) {
    const ids = places.flat().map((c) => c.id);
    return lanes ? laneOrder(lanes, ids, this.collapsed()) : ids.flatMap((id) => inColumn(shown, id));
  }

  /** The ids of the folded lanes. Ids of spaces that are gone stay: a machine that is offline lists none. */
  collapsed() {
    const list = shared(KEY_COLLAPSED);
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
  }

  toggleLane(id) {
    const set = this.collapsed();
    if (set.has(id)) set.delete(id); else set.add(id);
    setShared(KEY_COLLAPSED, [...set]);
  }

  /** The widest a column may be (px), or null for Auto. */
  maxWidth() {
    const w = shared(KEY_WIDTH);
    return typeof w === "number" && w >= MIN_COLUMN ? w : null;
  }

  /** Moves the width control one step: -1 narrower, +1 wider. Auto is the widest step. */
  stepWidth(dir) {
    const now = WIDTHS.indexOf(this.maxWidth());
    const next = Math.min(WIDTHS.length - 1, Math.max(0, (now < 0 ? WIDTHS.length - 1 : now) + dir));
    setShared(KEY_WIDTH, WIDTHS[next]);
  }

  density() {
    const d = shared(KEY_DENSITY);
    return DENSITIES.includes(d) ? d : "auto";
  }

  cardView() {
    const v = shared(KEY_CARDS);
    return CARD_VIEWS.includes(v) ? v : "auto";
  }

  /** True when the cards show summarized. Auto follows the board. */
  summary(boardCompact) {
    const v = this.cardView();
    return v === "auto" ? boardCompact : v === "summary";
  }

  /** How the bar shows now: "icons", "names" or "mixed" (see barLook). */
  barLook() { return barLook(this.density(), this.barW, BAR_WIDE, LABELS_WIDE); }

  /** Whether the board stacks its pairs: "auto", "on" or "off". Absent, the first read saves what an older density meant. */
  pairs() {
    const v = shared(KEY_PAIRS);
    if (PAIRS.includes(v)) return v;
    const next = pairsOf(shared(KEY_DENSITY));
    setShared(KEY_PAIRS, next);
    return next;
  }

  /** The command kanban.pairs: auto -> on -> off -> auto. */
  stepPairs() { setShared(KEY_PAIRS, PAIRS[(PAIRS.indexOf(this.pairs()) + 1) % PAIRS.length]); }

  /** True when the board stacks its pairs and shows smaller heads and cards. `wide`: the board width below which Auto does. */
  boardCompact(wide) {
    boardNow().stacks = typeof this.boardW === "number" ? stacks("auto", this.boardW, wide) : undefined;
    return stacks(this.pairs(), this.boardW, wide);
  }

  /** Whether the board stacks now, for a copy without its width: Auto as the board last decided (not yet: no). */
  stacked() {
    const p = this.pairs();
    return p === "auto" ? boardNow().stacks === true : p === "on";
  }

  /** The cards after the filter and the search text: the agents, then the terminal cards. */
  visible() {
    const q = String(shared(KEY_QUERY) ?? "").trim().toLowerCase(), f = this.activeFilter();
    const scoped = this.withWaiting(applyFilter(agents(), f, machineOf)), terms = applyFilter(this.terminalCards(), f, machineOf);
    if (!q) return [...scoped, ...terms];
    const hit = (text) => text.toLowerCase().includes(q);
    return [...scoped.filter((a) => {
      const pane = panes().find((p) => p.pane === a.pane);
      return hit(`${a.title} ${a.program?.name} ${a.space_name} ${a.tab_name} ${pane?.branch ?? ""}`);
    }), ...terms.filter((c) => hit(`${c.name} ${c.space_name} ${c.cwd ?? ""} ${c.program?.name ?? ""}`))];
  }

  /** The tabs with no agent, as cards (see terminalTabs), each with the name its tab shows. */
  terminalCards() {
    return terminalTabs(spaces(), agents(), panes(), spaceName).map((c) => ({ ...c, name: this.tabLabel(c.tab_name, c.place) }));
  }

  /** The name of a tab as Herdr shows it: `raw`, or "Tab <n>" for a tab nobody named. */
  tabLabel(raw, n) {
    const name = String(raw ?? "").trim();
    return name && !unnamed(name) ? name : this.s("tabNumber", { n });
  }

  detailHidden() { return Boolean(find(layout(), "detail")?.hidden); }

  /** True while the tab panel takes the place of the board. */
  maximized() { return Boolean(find(layout(), "board")?.hidden); }

  age(ms) {
    if (!ms) return "";
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return this.s("now");
    if (m < 60) return this.s("min", { n: m });
    const h = Math.floor(m / 60);
    return h < 24 ? this.s("hour", { n: h }) : this.s("day", { n: Math.floor(h / 24) });
  }

  // ---- actions -------------------------------------------------------------

  /** Shows the tab of card `a` in the panel: its space and tab become the active ones (the panel shows the active
   *  tab), its pane gets the keyboard. Ids go as agents() and spaces() give them: remote ones keep their "<machine>/".
   *  A terminal card has no agent to focus. */
  select(a) {
    this.guard(() => Promise.all([a.term ? null : run("agent.focus", { terminal: a.address }), ...this.showCard(a), this.showDetail()]));
  }

  showCard(a) {
    return [run("space.select", { id: a.space }), run("tab.select", { id: a.tab }), a.address ? run("pane.focus", { terminal: a.address }) : null];
  }

  showDetail() { return this.detailHidden() ? run("layout.show", { id: "detail" }) : null; }

  /** kanban.next / kanban.prev: selects the card after (1) or before (-1) the selected one, round the end. The bar
   *  computes the order itself, so it holds while the board is hidden. */
  stepCard(step) {
    const shown = this.visible(), hidden = this.hidden();
    const places = this.places(this.columns().filter((c) => !hidden.has(c.id)), this.stacked());
    // A key repeat comes before the last select lands, so it goes on from that card, not from the old focus.
    const f = focused(), tab = shownTab().id, at = { from: this.steppedTo(), tab, terminal: f?.terminal, pane: f?.pane };
    const a = nextCard(this.cardOrder(shown, places), at, step);
    if (!a) return;
    this.stepped = { address: a.address, tab: a.tab, was: { tab, terminal: f?.terminal } };
    this.select(a);
  }

  /** The address (its tab, for a card without one) of the card the last stepCard selected while the shown tab and
   *  the focused terminal are still on their way there (each the old or the new one); else null, and it is forgotten. */
  steppedTo() {
    const s = this.stepped, tab = shownTab().id, term = focused()?.terminal;
    // A card with no terminal has landed once its tab shows.
    const landed = s && tab === s.tab && (s.address == null || term === s.address);
    const moving = s && !landed && [s.was.tab, s.tab].includes(tab) && [s.was.terminal, s.address].includes(term);
    if (!moving) this.stepped = null;
    return this.stepped ? this.stepped.address ?? this.stepped.tab : null;
  }

  /** Maximizes the tab panel (the board hides, the panel takes the rest of its row or column) or restores the board
   *  with the panel size from before; `off`: restores the board, then hides the panel. Layout clicks, not layout.set:
   *  Herdr keeps them across restarts. */
  toggleMaximize(off = false) {
    // One copy acts: the bar, which also takes the commands kanban.maximize and kanban.place-off.
    if (this.part !== "bar") return run(off ? "kanban.place-off" : "kanban.maximize");
    // Waits for a place move to land (maxLater), so the clicks never mix two places and board and panel never both hide.
    if (this.placing()) { this.pendingMax = off || this.pendingMax === "off" ? "off" : true; return; }
    const root = layout(), detail = find(root, "detail");
    if (!detail || !find(root, "board")) return;
    const saved = this.panelSizes()[axis(placeOf(root) ?? "right")];
    if (this.maximized()) {
      const px = shared(KEY_MAXIMIZED);
      setShared(KEY_MAXIMIZED, null);
      return this.guard(() => Promise.all([run("layout.show", { id: "board" }),
        run("layout.resize", { id: "detail", px: typeof px === "number" && px > 0 ? px : saved }),
        off ? run("layout.hide", { id: "detail" }) : null]));
    }
    if (off) return this.guard(() => run("layout.hide", { id: "detail" }));
    setShared(KEY_MAXIMIZED, detail.size?.px ?? saved);
    this.guard(() => Promise.all([this.showDetail(), run("layout.hide", { id: "board" }), run("layout.resize", { id: "detail", weight: 1 })]));
  }

  /** Where the tab panel shows, hidden or not: right, left or bottom. */
  panelPlace() {
    const v = shared(KEY_PLACE);
    return PLACES.includes(v) ? v : "right";
  }

  /** The px of the tab panel at a side (its width) and at the bottom (its height). */
  panelSizes() {
    const v = shared(KEY_PANEL_SIZE) ?? {}, px = (n, d) => (typeof n === "number" && n > 0 ? n : d);
    return { side: px(v.side, DETAIL_PX), bottom: px(v.bottom, DETAIL_BOTTOM_PX) };
  }

  /** Shows the tab panel at `place`; "off" hides it (a maximized one restores the board first) and keeps the place.
   *  The bar moves the panel on its next render (placePanel). */
  setPlace(place) {
    if (place !== "off") {
      setShared(KEY_PLACE, place);
      return this.guard(() => this.showDetail());
    }
    if (this.maximized()) return this.toggleMaximize(true);
    if (!this.detailHidden()) this.guard(() => run("layout.hide", { id: "detail" }));
  }

  /** Runs a maximize click that waited for a move of the panel (toggleMaximize), unless this render edits the tree. */
  maxLater(busy) {
    if (busy || !this.pendingMax) return;
    const off = this.pendingMax === "off";
    this.pendingMax = false;
    this.toggleMaximize(off);
  }

  /** True while a move of the tab panel waits for its layout.set to land. */
  placing() {
    const tried = this.placeTry;
    return Boolean(tried) && tried.renders < MIGRATE_RENDERS && Date.now() - tried.at < MIGRATE_MS;
  }

  stepPlace() { this.setPlace({ right: "bottom", bottom: "left", left: "right" }[this.panelPlace()]); }

  /** Puts the tab panel where KEY_PLACE says, in one layout.set, and keeps the size of each place (see place.js).
   *  One attempt per layout and place; true while it waits for its layout.set to land. */
  placePanel(root) {
    const want = this.panelPlace(), now = placeOf(root), name = shared("layout"), tried = this.placeTry;
    // A new place comes from setPlace, which shows the panel: its move must not write back a stale hidden.
    if (want !== this.placeSeen) { this.placeShow = this.placeSeen !== undefined; this.placeSeen = want; }
    if (tried && (tried.name !== name || !now || now === tried.want)) {
      // Landed. A size the person dragged earlier is a layout click and may beat the tree: set it once more.
      if (tried.name === name && now && tried.px && find(root, "detail")?.size?.px !== tried.px) {
        this.guard(() => run("layout.resize", { id: "detail", px: tried.px }));
      }
      this.placeTry = null;
    } else if (tried) {
      // A move from the old tree would save its sizes on the wrong axis: a newer place waits in shared until it lands.
      if (++tried.renders <= MIGRATE_RENDERS && Date.now() - tried.at < MIGRATE_MS) return true;
      if (tried.want === want) { this.placeShow = false; return false; }
    }
    const show = this.placeShow;
    this.placeShow = false;
    if (!now || now === want) return false;
    const held = shared(KEY_MAXIMIZED), moved = movePanel(root, want, this.panelSizes(), held);
    this.placeTry = { name, want, at: Date.now(), renders: moved ? 0 : MIGRATE_RENDERS, px: moved?.px };
    if (!moved) return false;
    const shown = find(moved.tree, "detail");
    if (show && shown.hidden) shown.hidden = false;
    try { run("layout.set", { layout: moved.tree }); } catch (e) {
      console.log(`kanban: place: ${e?.message ?? e}`);
      this.placeTry.renders = MIGRATE_RENDERS; // it will not land: no wait
      return true;
    }
    setShared(KEY_PANEL_SIZE, moved.sizes);
    if (moved.held !== held) setShared(KEY_MAXIMIZED, moved.held);
    return true;
  }

  /** Reads dock/panels.json. A missing file is an empty list. A broken file keeps the last good list. */
  async loadEntries(cx) {
    let problem = null;
    try {
      const text = await readTextFile(`${appHome()}/dock/panels.json`);
      if (text === null) this.entries = [];
      else {
        const mods = new Set(await fs.readdir(`${appHome()}/mods`));
        const list = JSON.parse(text)?.panels;
        if (!Array.isArray(list)) throw new Error('expected {"panels": [...]}');
        const seen = new Set(), entries = [];
        for (const raw of list) {
          const command = raw?.opens === "command";
          const why = !raw || typeof raw !== "object" ? "not an object"
            : !ID.test(String(raw.id)) ? `bad id "${raw.id}" (use a-z, 0-9, -)`
            : seen.has(raw.id) ? `id "${raw.id}" twice`
            : typeof raw.label !== "string" || !raw.label ? `"${raw.id}" has no label`
            : typeof raw.icon !== "string" || !raw.icon ? `"${raw.id}" has no icon`
            : command && (typeof raw.run !== "string" || !raw.run) ? `"${raw.id}" has no run`
            : !command && (typeof raw.mod !== "string" || !mods.has(raw.mod)) ? `"${raw.id}": mod "${raw.mod}" is not in mods/`
            : raw.group !== undefined && !ID.test(String(raw.group)) ? `"${raw.id}": bad group "${raw.group}" (use a-z, 0-9, -)`
            : null;
          if (why) { problem = problem ?? why; continue; }
          seen.add(raw.id);
          entries.push({ id: raw.id, label: raw.label, icon: raw.icon, mod: raw.mod, props: raw.props, group: raw.group,
            run: command ? raw.run : undefined, args: command && raw.args && typeof raw.args === "object" ? raw.args : {},
            opens: command ? "command" : raw.opens === "tab" ? "tab" : "panel", name: typeof raw.name === "string" ? raw.name : raw.label });
        }
        this.entries = entries;
      }
    } catch (e) {
      problem = `panels.json: ${e?.message ?? e}`;
    }
    this.loaded = true;
    this.version++;
    if (problem && problem !== this.problem) notify({ title: "Kanban: panels.json", body: problem, level: "error", timeout: 6000 });
    this.problem = problem;
    cx.notify();
  }

  /** Adds the blocks the file asks for to the side panel stack, and takes away the ones this bar
   *  added before that the file no longer lists. One attempt per file version and layout. */
  inject(root, body, wanted) {
    const keep = new Set(wanted.map((e) => e.id));
    const missing = wanted.filter((e) => !body.children.some((c) => c.id === e.id));
    const stale = body.children.filter((c) => this.injected.has(c.id) && !keep.has(c.id));
    if (!missing.length && !stale.length) return false;
    // The place is in the key: a move built on the tree before this edit landed drops the blocks, so try again.
    const key = `${shared("layout")}|${placeOf(root)}|${this.version}|${[...offMods()].sort().join(",")}`;
    if (key === this.lastTry) return false;
    this.lastTry = key;
    const tree = JSON.parse(JSON.stringify(root)), target = find(tree, "panel-body");
    target.children = target.children.filter((c) => !stale.some((s) => s.id === c.id));
    if (stale.some((s) => s.id === target.active)) target.active = "files";
    for (const e of missing) target.children.push({ id: e.id, type: "block", content: { mod: e.mod, ...(e.props ? { props: e.props } : {}) } });
    // The layout file keeps no marker on a block, so the bar remembers which ones it added.
    for (const s of stale) this.injected.delete(s.id);
    for (const e of missing) this.injected.add(e.id);
    try { localStorage.setItem("kanban.injected", JSON.stringify([...this.injected])); } catch {}
    run("layout.set", { layout: tree });
    return true;
  }

  /** The entries of panels.json whose mod is on. */
  liveEntries() {
    const off = offMods();
    return off.size ? this.entries.filter((e) => !off.has(entryMod(e))) : this.entries;
  }

  /** Makes the layout follow the mods that are on (the same as reconcile in mods/tabs-dock). A block of a mod
   *  that is off (shared KEY_OFF) is hidden; a block of an off replacement mod shows Herdr's own mod (ORIGINALS).
   *  When the mod is on again, the bar shows the block again, or puts the mod back. A side panel that shows a
   *  hidden block closes. One attempt for each layout and wanted change, as in inject(); true when it ran layout.set. */
  reconcile(root) {
    const name = shared("layout"), off = offMods();
    const tree = JSON.parse(JSON.stringify(root));
    let changed = false;
    const walk = (node) => {
      for (const child of node?.children ?? []) walk(child);
      const mod = node?.content?.mod, key = `${name}|${node?.id}`;
      if (!node?.id || typeof mod !== "string") return;
      const mine = this.kitOff[key];
      if (mine && !off.has(mine)) {
        // The mod is on again: undo what this bar did (only when the block is still as the bar left it).
        if (ORIGINALS[mine] && mod === ORIGINALS[mine]) { node.content = { ...node.content, mod: mine }; changed = true; }
        else if (!ORIGINALS[mine] && mod === mine && node.hidden) { delete node.hidden; changed = true; }
        delete this.kitOff[key];
      } else if (off.has(mod)) {
        if (ORIGINALS[mod]) node.content = { ...node.content, mod: ORIGINALS[mod] };
        else if (!node.hidden) node.hidden = true;
        else return;
        this.kitOff[key] = mod;
        changed = true;
      }
    };
    walk(tree);
    const panel = sidePanel(tree), body = find(tree, "panel-body");
    if (panel && !panel.hidden && (body?.children ?? []).some((c) => c.id === body.active && c.hidden)) { panel.hidden = true; changed = true; }
    try { localStorage.setItem("kanban.kitOff", JSON.stringify(this.kitOff)); } catch {}
    if (!changed) { this.reconcileTry = null; return false; }
    const attempt = `${name}|${JSON.stringify(tree)}`;
    if (attempt === this.reconcileTry) return false;
    this.reconcileTry = attempt;
    run("layout.set", { layout: tree });
    return true;
  }

  /** A button of dock/panels.json that is not a side panel: a tab or a command. */
  runEntry(entry) {
    if (entry.opens === "tab") {
      showTab(entry.mod, entry.name);
      this.showDetail(); // the tab shows in the tab panel
      return;
    }
    run(entry.run, entry.args ?? {});
  }

  /** Opens the panel `id` in the side panel or in a dialog (see panelOpen), or closes it when it already shows
   *  there. A click on another panel button closes the open dialog first. A tab entry of dock/panels.json
   *  (Insights) opens in a dialog too, else in its tab. */
  togglePanel(id) {
    const live = this.liveEntries();
    // A key of a panel whose mod is off does nothing.
    if (live.length < this.entries.length && this.entries.some((e) => e.id === id) && !live.some((e) => e.id === id)) return;
    const command = live.find((e) => e.id === id && e.opens === "command");
    if (command) return this.runEntry(command); // a command of a group menu
    const root = layout(), panel = sidePanel(root), body = find(root, "panel-body");
    const tab = live.find((e) => e.id === id && e.opens === "tab");
    const node = (body?.children ?? []).find((c) => c.id === id && !c.hidden);
    if (!tab && (!panel || !node)) return;
    const open = shared(KEY_PANEL_DIALOG);
    if (open?.id) {
      closeOverlay(open.id);
      setShared(KEY_PANEL_DIALOG, null);
      if (open.panel === id && liveDialogs().has(open.id)) return;
    }
    // A panel that shows in the side panel now (also one moved there from a dialog) closes, in every mode.
    if (node && panel && !panel.hidden && body.active === id) return run("layout.hide", { id: panel.id });
    if (this.dialogNow()) return this.openDialog(id, tab ? { mod: tab.mod, ...(tab.props ? { props: tab.props } : {}) } : node.content, tab);
    if (tab) return this.runEntry(tab);
    if (!panel.hidden && body.active === id) run("layout.hide", { id: panel.id });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: panel.id }); }
  }

  panelOpen() {
    const v = shared(KEY_PANEL_OPEN);
    return PANEL_OPENS.includes(v) ? v : "auto";
  }

  stepPanelOpen() {
    const i = PANEL_OPENS.indexOf(this.panelOpen());
    setShared(KEY_PANEL_OPEN, PANEL_OPENS[(i + 1) % PANEL_OPENS.length]);
  }

  /** True when a panel button opens a dialog now: always in Dialog, below PANEL_NARROW px of bar in Auto. */
  dialogNow() {
    const v = this.panelOpen();
    return v === "dialog" || (v === "auto" && typeof this.barW === "number" && this.barW < PANEL_NARROW);
  }

  /** Opens the panel `id` in a dialog: a title row (this mod, part "panel-title") over `content`, the same mod
   *  and props as in the side panel (or in the tab, for a `tab` entry). The dialog holds a layout, so the panel
   *  gets a real block, as in the side panel. Its own copy starts fresh. */
  openDialog(id, content, tab = null) {
    if (!content?.mod) return;
    const entry = [...PANELS, ...this.entries].find((e) => e.id === id);
    const title = { part: "panel-title", panel: id, label: entry?.label ?? id, icon: entry?.icon ?? "", lang: this.lang,
      ...(tab ? { tab: { mod: tab.mod, name: tab.name } } : {}) };
    const overlay = openOverlay({
      kind: "dialog", width: 0.82, height: 0.85,
      layout: { type: "column", children: [
        { id: "panel-dialog-title", type: "block", size: { px: DIALOG_TITLE }, content: { mod: "kanban", props: title } },
        { id: `panel-dialog-${id}`, type: "block", content },
      ] },
    });
    liveDialogs().add(overlay);
    setShared(KEY_PANEL_DIALOG, { id: overlay, panel: id });
  }

  /** The panel that shows in a dialog now, or null. */
  dialogPanel() {
    const open = shared(KEY_PANEL_DIALOG);
    return open?.id && liveDialogs().has(open.id) ? open.panel : null;
  }

  /** The title row of a panel dialog: the icon and name of the panel, a button that moves it to the side
   *  panel (to its tab, for a tab entry) and a close button. Esc and a click beside the dialog close it too. */
  panelTitle(t) {
    const p = this.props;
    const path = String(p.icon || "");
    const glyph = !path ? div().size(14) : path.endsWith(".svg") ? svg(path).size(14).text_color(t.accent) : image(path).size(14);
    const move = p.tab
      ? iconButton(t, "kb-dlg-tab", "open", () => this.dialogToSide(), { tooltip: this.s("toTab"), size: 26, glyph: 14 })
      : iconButton(t, "kb-dlg-side", "panel", () => this.dialogToSide(), { tooltip: this.s("toSide"), size: 26, glyph: 14 });
    return h_flex().id("kb-dlg-title").size_full().pl(14).pr(8).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeDialog(); } })
      .child(glyph.flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(String(p.label ?? "")))
      .child(move)
      .child(iconButton(t, "kb-dlg-close", "close", () => this.closeDialog(), { tooltip: this.s("closeDialog"), size: 26, glyph: 13 }));
  }

  closeDialog() {
    const id = this.overlay ?? shared(KEY_PANEL_DIALOG)?.id;
    if (id) closeOverlay(id);
  }

  // The title row of a panel dialog takes the keyboard when the dialog opens. Else the terminal
  // behind the dialog keeps it and gets Esc. The panel in the dialog can take the keyboard later
  // (a filter field after 40 ms), so this runs at once and once more after 10 ms.
  takeKeys(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(10, () => this.handle.focus());
  }

  /** The name and the icon of a group button. */
  groupInfo(group) {
    const known = PANEL_GROUPS[group], first = this.groups.get(group)?.[0];
    return { label: known?.label ?? layoutLabel(group), icon: known?.icon ?? first?.icon ?? "" };
  }

  /** Opens the menu of a group button at the pointer: one row per panel of the group, with its full name. The rows
   *  come from the last render (lit = open now). A popup is as tall as its content, so the height is set here. */
  openGroup(group) {
    const members = this.groups?.get(group);
    if (!members?.length) return;
    const info = this.groupInfo(group);
    openOverlay({
      mod: "kanban", kind: "popup", width: MENU_W, height: MENU_PAD * 2 + MENU_HEAD + members.length * MENU_ROW,
      props: { part: "group-menu", lang: this.lang, title: info.label, items: members.map((m) => ({ id: m.id, label: m.label, icon: m.icon, on: m.on })) },
    });
  }

  /** The menu of a group button: the name of the group, then one row per panel (icon, full name, a tick while it is
   *  open). A click closes the menu and sends the panel to the bar ("kanban.panel-<id>"), as a click on its button does. */
  groupMenu(t) {
    const p = this.props, items = Array.isArray(p.items) ? p.items : [];
    const row = (it) => h_flex().id(`kb-gm-${it.id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(it.on ? t.accent : t.foreground)
      .when(it.on, (e) => e.bg(tint(t.accent, "1a")))
      .hover((s) => s.bg(it.on ? tint(t.accent, "33") : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.pick(it.id); })
      .child(panelGlyph(it.icon, 15, it.on ? t.accent : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(String(it.label ?? it.id)))
      .when(it.on, (e) => e.child(svg(icon("tick")).size(13).flex_none().text_color(t.accent)));
    return v_flex().id("kb-gm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(String(p.title ?? "")))
      .children(items.map(row));
  }

  pick(id) {
    run(`kanban.panel-${id}`);
    if (this.overlay) closeOverlay(this.overlay);
  }

  /** Opens the columns menu at the pointer (a right click on the board, a column head or a hidden column). */
  openColumns() {
    openOverlay({ mod: "kanban", kind: "popup", width: MENU_W, height: MENU_PAD * 2 + MENU_HEAD + this.columns().length * MENU_ROW,
      props: { part: "columns-menu", lang: this.lang, waiting: this.props.waiting, counts: this.columnCounts() } });
  }

  /** The columns menu: one row per column (its dot, name and card count, a tick while it shows). A click shows or
   *  hides the column and the menu stays open, as the chips of the gear menu. */
  columnsMenu(t) {
    const row = (it) => h_flex().id(`kb-cols-${it.c.id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(it.on ? t.foreground : t.dim).hover((s) => s.bg(t.hover)).tooltip(it.tooltip)
      .on_click((_e, cx) => { cx.stop_propagation(); it.flip(); })
      .child(div().size(8).rounded(4).flex_none().when(it.on, (e) => e.bg(statusColor(t, it.c.id)))
        .when(!it.on, (e) => e.border_1().border_color(t.dim)))
      .child(div().flex_1().min_w(0).truncate().child(it.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(it.count)))
      .child(div().w(13).flex_none().when(it.on, (e) => e.child(svg(icon("tick")).size(13).text_color(t.accent))));
    return v_flex().id("kb-cols-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(this.s("columnsTitle")))
      .children(this.columnToggles(this.props.counts).map(row));
  }

  /** The rows of the filter menu: all, the current space, the spaces, and the machines when there are more than one.
   *  A row is { id, filter, symbol, label, note?, machine? }, a section head { head }. */
  filterItems() {
    const list = this.machineRow(), here = spaces();
    return [
      { id: "all", filter: { kind: "all" }, symbol: "board", label: this.s("filterAll") },
      { id: "current", filter: { kind: "current" }, symbol: "locate", label: this.s("filterCurrent"), note: spaceName(here.find((p) => p.active)) },
      ...(here.length ? [{ head: this.s("filterSpaces") }] : []),
      ...here.map((p) => ({ id: `s-${p.id}`, filter: { kind: "space", id: p.id }, symbol: "folder", label: spaceName(p), machine: p.machine ?? null })),
      ...(list.length > 1 ? [{ head: this.s("filterMachines") }, ...list.map((m) => ({ id: `m-${m.name ?? ""}`,
        filter: { kind: "machine", id: m.name ?? null }, symbol: "server", label: m.name ?? this.s("thisComputer") }))] : []),
    ];
  }

  /** Opens the filter menu at the pointer, as tall as its rows up to FILTER_MAX (then it scrolls). */
  openFilter() {
    const items = this.filterItems(), heads = items.filter((it) => it.head).length;
    openOverlay({ mod: "kanban", kind: "popup", width: FILTER_W,
      height: Math.min(FILTER_MAX, MENU_PAD * 2 + heads * MENU_HEAD + (items.length - heads) * MENU_ROW),
      props: { part: "filter-menu", lang: this.lang } });
  }

  /** The filter menu: a tick on what the board shows now. A click saves the filter and closes the menu. */
  filterMenu(t) {
    const now = this.activeFilter();
    const isOn = (f) => f.kind === now.kind && (f.kind === "space" ? f.id === now.space.id : f.kind === "machine" ? f.id === now.machine : true);
    const head = (label) => h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(label);
    const row = (it, on) => h_flex().id(`kb-flt-${it.id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(on ? t.accent : t.foreground)
      .when(on, (e) => e.bg(tint(t.accent, "1a")))
      .hover((s) => s.bg(on ? tint(t.accent, "33") : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); setShared(KEY_FILTER, it.filter); if (this.overlay) closeOverlay(this.overlay); })
      .child(svg(icon(it.symbol)).size(15).flex_none().text_color(on ? t.accent : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(it.label))
      .when(Boolean(it.note), (e) => e.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(it.note)))
      .when(Boolean(it.machine), (e) => e.child(machineChip(t, `kb-flt-chip-${it.id}`, it.machine)))
      .child(div().w(13).flex_none().when(on, (e) => e.child(svg(icon("tick")).size(13).text_color(t.accent))));
    return v_flex().id("kb-flt-root").size_full().min_h(0).p(MENU_PAD).overflow_y_scrollbar()
      .children(this.filterItems().map((it) => (it.head ? head(it.head) : row(it, isOn(it.filter)))));
  }

  /** Opens the place menu of the tab panel at the pointer. */
  openPlace() {
    openOverlay({ mod: "kanban", kind: "popup", width: PLACE_W, height: MENU_PAD * 2 + PLACE_ROWS.length * MENU_ROW,
      props: { part: "place-menu", lang: this.lang } });
  }

  /** The place menu: Off, Right, Left, Bottom, a tick on the one now. A click sets it and closes the menu. */
  placeMenu(t) {
    const now = this.detailHidden() ? "off" : this.panelPlace();
    const row = (p) => {
      const on = p === now;
      return h_flex().id(`kb-place-${p}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(13).text_color(on ? t.accent : t.foreground)
        .when(on, (e) => e.bg(tint(t.accent, "1a")))
        .hover((s) => s.bg(on ? tint(t.accent, "33") : t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.setPlace(p); if (this.overlay) closeOverlay(this.overlay); })
        .child(svg(icon(PLACE_ICONS[p])).size(15).flex_none().text_color(on ? t.accent : t.muted))
        .child(div().flex_1().min_w(0).truncate().child(this.s(`place_${p}`)))
        .child(div().w(13).flex_none().when(on, (e) => e.child(svg(icon("tick")).size(13).text_color(t.accent))));
    };
    return v_flex().id("kb-place-root").w_full().p(MENU_PAD).children(PLACE_ROWS.map(row));
  }

  /** The gear button opens a menu: the look of the board, the columns, Herdr's settings, the editor of the bar
   *  buttons and, with the mods-hub installed, the PowerMods dialog. The card counts are those of now. */
  openGear() {
    const given = { part: "gear-menu", lang: this.lang, waiting: this.props.waiting, bar: this.barLook(),
      narrow: typeof this.barW === "number" && this.barW < PANEL_NARROW, counts: this.columnCounts() };
    // Room for every column, so the menu still fits after the Waiting column is turned on.
    const height = (hub) => MENU_PAD * 2 + 2 * MENU_HEAD + 5 * GEAR_ROW + (1 + COLUMNS.length + (hub ? 3 : 2)) * MENU_ROW + GEAR_HINT + GEAR_SEP;
    const open = (hub) => openOverlay({ mod: "kanban", kind: "popup", width: GEAR_W, height: height(hub), props: { ...given, hub } });
    readTextFile(`${appHome()}/mods/mods-hub/mod.json`).then((text) => open(text != null), () => open(false));
  }

  /** Opens the editor of the bar buttons: one row per button of the panel group (a group button is one row), from
   *  the last render. A popup is as tall as its content, so the height is set here. */
  openButtons() {
    const items = this.buttonItems ?? [];
    if (!items.length) return;
    openOverlay({ mod: "kanban", kind: "popup", width: EDIT_W, height: MENU_PAD * 2 + MENU_HEAD + items.length * MENU_ROW + EDIT_FOOT,
      props: { part: "buttons-menu", lang: this.lang, items } });
  }

  /** The editor of the bar buttons: one row per button (icon, name, up, down, show or hide) in the order of the bar,
   *  and a Reset row. It reads and writes the shared key, so both bars change at once and the popup stays open.
   *  The same as buttonsMenu in mods/tabs-dock. */
  buttonsMenu(t) {
    const items = Array.isArray(this.props.items) ? this.props.items : [];
    const prefs = barButtons(), rows = arrange(items, prefs.order), hidden = new Set(prefs.hidden);
    const save = (next) => setShared(KEY_BUTTONS, { order: prefs.order, hidden: prefs.hidden, ...next });
    const move = (i, step) => {
      const list = rows.map((r) => r.id), j = i + step;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      save({ order: list });
    };
    const flip = (id) => save({ hidden: hidden.has(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id] });
    const tool = (id, name, tip, fn, enabled = true) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .tooltip(tip)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); fn(); }))
      .child(svg(icon(name)).size(14).text_color(enabled ? t.muted : t.border));
    const row = (it, i) => {
      const off = hidden.has(it.id);
      return h_flex().id(`kb-bm-${it.id}`).w_full().h(MENU_ROW).pl(10).pr(2).gap(8).flex_none().items_center().rounded(6)
        .text_size(13).text_color(off ? t.dim : t.foreground).hover((s) => s.bg(tint(t.foreground, "0a")))
        .child(panelGlyph(it.icon, 15, off ? t.dim : t.muted))
        .child(div().flex_1().min_w(0).truncate().child(String(it.label ?? it.id)))
        .child(tool(`kb-bm-up-${it.id}`, "chevron-up", this.s("moveUp"), () => move(i, -1), i > 0))
        .child(tool(`kb-bm-down-${it.id}`, "chevron-down", this.s("moveDown"), () => move(i, 1), i < rows.length - 1))
        .child(tool(`kb-bm-eye-${it.id}`, off ? "eye-off" : "eye", this.s(off ? "showButton" : "hideButton"), () => flip(it.id)));
    };
    const changed = prefs.order.length > 0 || prefs.hidden.length > 0;
    return v_flex().id("kb-bm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(this.s("buttonsTitle")))
      .children(rows.map(row))
      .child(h_flex().w_full().h(EDIT_FOOT).px(6).pt(6).flex_none().items_center().justify_end().border_t(1).border_color(t.border)
        .child(h_flex().id("kb-bm-reset").h(24).px(10).flex_none().items_center().rounded(6).text_size(12)
          .border_1().border_color(t.border).text_color(changed ? t.foreground : t.dim)
          .when(changed, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); setShared(KEY_BUTTONS, null); }))
          .child(this.s("resetButtons"))));
  }

  /** The menu of the gear button. The settings write their shared keys at once and the menu stays open. "PowerMods" opens
   *  the dialog on its Settings tab, on the section of this bar (the tab and the section that the mods-hub keeps in
   *  shared("mods-hub")). mod.open toggles: an open dialog closes. "Bar buttons" asks the bar for the editor
   *  ("kanban.buttons"): the bar knows the buttons. The links close the menu. */
  gearMenu(t) {
    const p = this.props;
    const go = (fn) => { fn(); if (this.overlay) closeOverlay(this.overlay); };
    const head = (label) => h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(label);
    const row = (id, symbol, label, fn) => h_flex().id(`kb-gear-${id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6)
      .cursor_pointer().text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); go(fn); })
      .child(svg(icon(symbol)).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label));
    const setting = (id, symbol, label, control) => h_flex().id(`kb-gear-${id}`).w_full().h(GEAR_ROW).pl(10).pr(2).gap(10).flex_none().items_center()
      .text_size(13).text_color(t.foreground)
      .child(svg(icon(symbol)).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(control);
    const choice = (id, values, now, key, tip, tips = {}) => segmented(t, values.map((v) => ({ id: `kb-gear-${id}-${v}`, label: this.s(`${id}_${v}`),
      active: v === now, tooltip: v === "auto" ? tip : tips[v] ?? "", onClick: () => setShared(key, v) })));
    const bar = this.s(p.bar === "icons" ? "densityNowIcons" : p.bar === "names" ? "densityNowNames" : "densityNowMixed",
      { mode: this.s("density_auto"), px: BAR_WIDE, labels: LABELS_WIDE });
    const stacked = boardNow().stacks;
    const pairs = this.s(stacked == null ? "pairsAuto" : stacked ? "pairsNowOn" : "pairsNowOff", { mode: this.s("pairs_auto"), px: COLUMN_WIDE });
    const opens = this.s(p.narrow ? "opensNowDialog" : "opensNowSide", { mode: this.s("opens_auto") });
    const waiting = this.waitingOn();
    const chip = (it) => h_flex().w_full().h(MENU_ROW).pl(6).flex_none().items_center()
      .child(columnChip(t, `kb-chip-${it.c.id}`, { label: it.name, color: statusColor(t, it.c.id), on: it.on, count: it.count, tooltip: it.tooltip }, it.flip));
    return v_flex().id("kb-gear-root").w_full().p(MENU_PAD)
      .child(head(this.s("gearTitle")))
      .child(setting("width", "width", this.s("widthLabel"), this.widthControl(t)))
      .child(setting("pairs", "stack", this.s("pairsLabel"), choice("pairs", PAIRS, this.pairs(), KEY_PAIRS, pairs, { on: this.s("pairsOn") })))
      .child(setting("cards", "cards", this.s("cardsLabel"), choice("cards", CARD_VIEWS, this.cardView(), KEY_CARDS, this.s("cardsAuto"))))
      .child(setting("density", "density", this.s("densityLabel"), choice("density", DENSITIES, this.density(), KEY_DENSITY, bar)))
      .child(setting("opens", "dialog", this.s("opensLabel"), choice("opens", PANEL_OPENS, this.panelOpen(), KEY_PANEL_OPEN, opens)))
      .child(h_flex().id("kb-gear-waiting").w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip(this.s(waiting ? "waitingOn" : "waitingOff"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleWaiting(); })
        .child(svg(icon("hourglass")).size(15).flex_none().text_color(waiting ? t.accent : t.muted))
        .child(div().flex_1().min_w(0).truncate().child(this.s("waitingLabel")))
        .when(waiting, (e) => e.child(svg(icon("tick")).size(13).flex_none().text_color(t.accent))))
      .child(head(this.s("columnsTitle")))
      .children(this.columnToggles(p.counts).map(chip))
      .child(h_flex().w_full().h(GEAR_HINT).px(10).flex_none().items_center()
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.s("orderHint"))))
      .child(div().w_full().h(1).my(4).flex_none().bg(t.border))
      .child(row("herdr", "settings", this.s("gearHerdr"), () => run("app.settings")))
      .child(row("buttons", "buttons", this.s("gearButtons"), () => run("kanban.buttons")))
      .when(this.props.hub !== false, (e) => e.child(row("mods", "mods", this.s("gearMods"), () => {
        setShared("mods-hub", { ...(shared("mods-hub") ?? {}), tab: "settings", section: "kanban" });
        run("mod.open", { name: "mods-hub" });
      })));
  }

  /** Opens the menu of the duplicate button of a card at the pointer: duplicate in the same space, or in a new worktree. */
  openClone(a) {
    const name = a.space_name || a.program?.name || a.app || "Agent";
    openOverlay({
      mod: "kanban", kind: "popup", width: CLONE_W, height: MENU_PAD * 2 + MENU_HEAD + 2 * MENU_ROW,
      props: { part: "clone-menu", lang: this.lang, title: this.s("cloneTitle", { name }), address: a.address },
    });
  }

  /** The menu of the duplicate button. A row starts a new session of the same agent, with the same flags and no
   *  session flag (see cloneArgv): in a new tab of the same space and folder, or in a new worktree of the repository
   *  (Herdr's worktree dialog asks for the branch and opens a new space with the agent in its first tab). */
  cloneMenu(t) {
    const p = this.props;
    const row = (id, symbol, label, where) => h_flex().id(`kb-cm-${id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6)
      .text_size(13).text_color(this.cloneBusy ? t.dim : t.foreground)
      .when(!this.cloneBusy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); this.clone(where, cx); })
      .child(svg(icon(symbol)).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label));
    return v_flex().id("kb-cm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(String(p.title ?? ""))))
      .child(row("here", "copy", this.s("cloneHere"), "here"))
      .child(row("worktree", "branch", this.s("cloneWorktree"), "worktree"));
  }

  /** Duplicates the agent of props.address. `where`: "here" (a new tab of its space) or "worktree". */
  clone(where, cx) {
    if (this.cloneBusy) return;
    const a = agents().find((x) => x.address === this.props.address);
    if (!a) { this.closeDialog(); return; }
    const space = spaces().find((s) => s.id === a.space);
    const folder = panes().find((x) => x.pane === a.pane)?.cwd || space?.folder || undefined;
    this.cloneBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let argv = null;
      try { argv = await cloneArgv(a.address, a.program?.key, space?.machine); } catch {}
      this.cloneBusy = false;
      // Act first, then close: this copy of the mod ends with its popup.
      if (!argv) notify({ title: this.s("cloneFail"), body: this.s("noCommand"), level: "error", timeout: 6000 });
      else if (where === "worktree") openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: a.space, folder, action: "new", argv } });
      else { run("tab.new", { space: a.space, argv, ...(folder ? { folder } : {}) }); this.showDetail(); }
      this.closeDialog();
    });
  }

  /** Opens the right-click menu of a card at the pointer: an agent goes by its address, a terminal card by its tab. */
  openCardMenu(a) {
    openOverlay({
      mod: "kanban", kind: "popup", width: CARD_MENU_W, height: MENU_PAD * 2 + MENU_HEAD + this.cardMenuItems(a).length * MENU_ROW,
      props: { part: "card-menu", lang: this.lang, ...(a.term ? { tab: a.tab } : { address: a.address }) },
    });
  }

  /** The rows of the card menu. The board builds them for the height, the popup to draw them. */
  cardMenuItems(a) {
    const agentsIn = agents().filter((x) => x.tab === a.tab).length, panesIn = panes().filter((p) => p.tab === a.tab).length;
    const what = agentsIn > 1 ? this.s("agents", agentsIn) : panesIn > 1 ? this.s("panes", panesIn) : null;
    return [
      { id: "rename", symbol: "pencil", label: this.s("menuRename"), run: () => this.openRename(a) },
      // No `confirmed`: Herdr asks before the last tab closes its space.
      { id: "close", symbol: "close", label: what ? this.s("menuCloseWith", { what }) : this.s("menuClose"), tip: this.s("menuCloseTip"),
        run: () => run("tab.close", { id: a.tab }) },
      // The two rows that start something stay together, and Rename and Close keep their place.
      { id: "new", symbol: "plus", label: this.s("menuNewHere"), more: true,
        run: () => this.openNew({ space: a.space, machine: spaces().find((s) => s.id === a.space)?.machine ?? machineOf(a) }) },
      { id: "clone", symbol: "copy", label: this.s("duplicate"), more: true, run: () => this.openClone(a) },
      // A click on the card shows its tab already; this row shows it on the whole width.
      { id: "maximize", symbol: "maximize", label: this.s("menuMaximize"),
        run: () => { this.select(a); if (!this.maximized()) this.toggleMaximize(); } },
      { id: "pin", symbol: "pin", label: this.s(a.pinned ? "unpin" : "pin"), run: () => this.togglePin(a) },
    ].filter((it) => !a.term || (it.id !== "clone" && it.id !== "pin")); // a terminal card has no agent to duplicate or pin
  }

  /** The card menu: the space and the tab of the card, then its rows. A row acts, then closes the menu. */
  cardMenu(t) {
    const tab = this.props.tab;
    const a = tab != null ? this.terminalCards().find((x) => x.tab === tab) : agents().find((x) => x.address === this.props.address);
    if (!a) { this.closeDialog(); return v_flex().id("kb-card-root"); }
    const row = (it) => h_flex().id(`kb-card-${it.id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6)
      .cursor_pointer().text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .when(Boolean(it.tip), (e) => e.tooltip(it.tip))
      // Act first, then close: this copy ends with its popup, and closeOverlay(id) spares a popup it just opened.
      .on_click((_e, cx) => { cx.stop_propagation(); this.guard(it.run, () => this.closeDialog()); })
      .child(svg(icon(it.symbol)).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(it.label))
      .when(Boolean(it.more), (e) => e.child(svg(icon("chevron-right")).size(12).flex_none().text_color(t.dim)));
    return v_flex().id("kb-card-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child([a.space_name, a.term ? a.name : a.tab_name].filter(Boolean).join(" · "))))
      .children(this.cardMenuItems(a).map(row));
  }

  /** Runs `fn`, then `done` once it settles; a command that fails (its machine is unavailable) shows a notice, not an error. */
  guard(fn, done = () => {}) {
    const fail = (e) => notify({ title: this.s("cardFail"), body: String(e?.message ?? e), level: "error", timeout: 6000 });
    let p;
    try { p = fn(); } catch (e) { fail(e); done(); return; }
    if (typeof p?.then === "function") Promise.resolve(p).catch(fail).finally(done);
    else done();
  }

  togglePin(a) { return run("terminal.pin", { terminal: a.address, pinned: !a.pinned }); }

  /** Opens the field that renames the tab of `a`, filled with its name (empty while the tab has only its number). */
  openRename(a) {
    const name = String(a.tab_name ?? "").trim();
    openOverlay({
      mod: "kanban", kind: "popup", width: RENAME_W, height: MENU_PAD * 2 + MENU_HEAD + RENAME_ROW + EDIT_FOOT,
      props: { part: "card-rename", lang: this.lang, tab: a.tab, name: unnamed(name) ? "" : name, space: a.space_name ?? "" },
    });
  }

  // The field takes the keyboard at once and again after 40 ms, as the tab-namer does.
  takeName(cx) {
    this.nameField = InputState.new({ placeholder: this.s("renameEmpty"), value: String(this.props.name ?? "") });
    this.nameField.on("submit", () => this.saveName());
    this.nameField.focus();
    cx.timer.after(40, () => this.nameField.focus());
  }

  /** Renames the tab of the rename popup; an empty name gives it its number again. */
  saveName() {
    const tab = this.props.tab, name = this.nameField.value().trim();
    this.guard(() => run("tab.rename", { id: tab, name }), () => this.closeDialog());
  }

  /** The rename popup: a head, the field, Cancel and Save. Enter saves, Esc cancels. */
  renameBox(t) {
    const tab = this.props.tab;
    // Close once the tab is gone: no agent, pane or spaces() entry left (an agent can exit while its tab stays).
    const alive = agents().some((x) => x.tab === tab) || panes().some((p) => p.tab === tab)
      || spaces().some((s) => (s.tabs ?? []).some((x) => x.id === tab));
    if (!alive) { this.closeDialog(); return v_flex().id("kb-rn-root"); }
    return v_flex().id("kb-rn-root").w_full().p(MENU_PAD)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeDialog(); } })
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child([this.s("renameTitle"), this.props.space].filter(Boolean).join(" · "))))
      .child(h_flex().w_full().h(RENAME_ROW).px(4).flex_none().items_center().child(textField(t, "kb-rn-field", this.nameField)))
      .child(h_flex().w_full().h(EDIT_FOOT).px(4).pt(6).gap(6).flex_none().items_center().justify_end()
        .child(button(t, "kb-rn-cancel", this.s("cancel"), () => this.closeDialog()))
        .child(button(t, "kb-rn-save", this.s("save"), () => this.saveName(), { primary: true })));
  }

  // ---- the New session dialog ------------------------------------------------

  /** Opens the dialog that starts a session, filled in from `pre` ({ space?, machine? }) when the card menu
   *  opens it. A dialog, not a popup: a form this tall does not fit beside the pointer, and Herdr's own
   *  worktree dialog (see clone) is the same kind of form. */
  openNew(pre = {}) {
    openOverlay({
      mod: "kanban", kind: "dialog", width: NEW_W, height: NEW_H,
      props: { part: "new-dialog", lang: this.lang, ...pre },
    });
  }

  // What the dialog holds: the machine (its name, null here), the space (null: a new one), the program
  // (null: a terminal) and the two names. The tab name takes the keyboard at once and again after 40 ms,
  // as the rename popup does.
  takeNew(cx) {
    // Filled in from the card menu; from the bar, the space of the window, so the dialog starts where the person is.
    const want = spaces().find((s) => s.id === (this.props.space ?? focused()?.space));
    const on = want ? want.machine ?? null : this.props.machine ?? null;
    const list = this.machineRow();
    this.machine = list.some((m) => (m.name ?? null) === on) ? on : list[0]?.name ?? null;
    this.space = want?.id ?? null;
    this.agent = null;
    this.known = null; // the agents of the machine; null while knownAgents runs
    this.newBusy = false;
    this.spaceField = InputState.new({ placeholder: this.s("newSpaceHint") });
    this.tabField = InputState.new({ placeholder: this.s("newTabHint") });
    for (const f of [this.spaceField, this.tabField]) f.on("submit", () => this.startNew());
    this.tabField.focus();
    cx.timer.after(40, () => this.tabField.focus());
    this.loadKnown(cx);
  }

  /** The machines a session can start on, this computer first; its name is null. */
  machineRow() {
    const list = machines().filter((m) => !m.temporary);
    return [...list.filter((m) => !m.name), ...list.filter((m) => m.name)];
  }

  /** True while the chosen machine cannot be reached: tab.new and space.new fail there. Read live, because
   *  a machine that was still loading when the dialog opened turns unavailable on the first failed read. */
  offline() { return this.machineRow().find((m) => (m.name ?? null) === this.machine)?.layout === "unavailable"; }

  /** The spaces of the chosen machine. */
  spacesHere() { return spaces().filter((s) => (s.machine ?? null) === this.machine); }

  /** The chosen space, or null for a new one (also once the chosen space is gone). */
  chosenSpace() { return this.spacesHere().some((s) => s.id === this.space) ? this.space : null; }

  /** Picks a machine by name: the space and the program belong to one, so both start over. */
  pickMachine(name, cx) {
    if (name === this.machine) return;
    this.machine = name;
    this.space = null;
    this.agent = null;
    this.loadKnown(cx);
    cx.notify();
  }

  /** Reads the agents people can start on the chosen machine. The newest pick wins, in whatever order
   *  the calls end; a check that fails leaves the list empty. */
  loadKnown(cx) {
    const on = this.machine;
    const turn = (this.knownTurn = (this.knownTurn ?? 0) + 1);
    this.known = null;
    cx.spawn(async (cx) => {
      let list = [];
      try { list = await knownAgents({ on }); } catch {}
      if (turn !== this.knownTurn) return;
      this.known = list.filter((k) => k.installed && Array.isArray(k.run) && k.run.length);
      cx.notify();
    });
  }

  /** Starts the session: a tab in the chosen space, or a new space with that first tab. `machine: ""` is
   *  this computer; leaving it out would follow the focused space instead. No argv: the machine's shell. */
  startNew() {
    if (this.newBusy || this.offline()) return; // Enter has to stop where the disabled Start button stops
    const argv = this.agent ? (this.known ?? []).find((k) => k.key === this.agent)?.run : null;
    const space = this.chosenSpace(), tab = this.tabField.value().trim(), name = this.spaceField.value().trim();
    this.newBusy = true;
    // Act first, then close: this copy of the mod ends with its dialog.
    this.guard(() => Promise.resolve(space != null
      ? run("tab.new", { space, ...(tab ? { name: tab } : {}), ...(argv ? { argv } : {}) })
      : run("space.new", { machine: this.machine ?? "", ...(name ? { name } : {}), ...(tab ? { tab } : {}), ...(argv ? { argv } : {}) }))
      .then(() => this.showDetail()),
      () => { this.newBusy = false; this.closeDialog(); });
  }

  /** The New session dialog: the machine, the space (an existing one or a new one), what to start and an
   *  optional tab name. The two lists share the height that is left, so the dialog does not grow with them. */
  newDialog(t) {
    const list = this.machineRow(), here = this.spacesHere(), space = this.chosenSpace();
    const known = this.known, off = this.offline();
    const head = (text) => h_flex().w_full().h(MENU_HEAD).px(8).flex_none().items_center()
      .text_size(11).font_semibold().text_color(t.dim).child(text);
    const hint = (text) => h_flex().w_full().h(NEW_ROW).px(8).flex_none().items_center().text_size(12).text_color(t.dim).child(text);
    const row = ({ id, on, glyph, label, note = "", tip = "", pick }) =>
      h_flex().id(id).w_full().h(NEW_ROW).px(8).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(13).text_color(on ? t.accent : t.foreground)
        .when(Boolean(tip), (e) => e.tooltip(tip))
        .when(on, (e) => e.bg(tint(t.accent, "1a")))
        .hover((s) => s.bg(on ? tint(t.accent, "33") : t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); pick(cx); cx.notify(); })
        .child(glyph)
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(Boolean(note), (e) => e.child(div().flex_none().max_w(120).truncate().text_size(11).text_color(t.dim).child(note)))
        .when(on, (e) => e.child(svg(icon("tick")).size(13).flex_none().text_color(t.accent)));
    // `label`: an empty one gives the field the whole row.
    const field = (id, label, state) => h_flex().w_full().h(NEW_FIELD).px(8).gap(8).flex_none().items_center()
      .when(Boolean(label), (e) => e.child(div().w(90).flex_none().text_size(12).text_color(t.dim).child(label)))
      .child(div().flex_1().min_w(0).child(textField(t, id, state)));
    // One machine (the usual case): its name, not a list of one.
    const machine = list.length > 1
      ? h_flex().flex_1().min_w(0).items_center().overflow_x_scrollbar().child(segmented(t, list.map((m) => ({
        id: `kb-nw-m-${m.name ?? ""}`, label: m.name ?? this.s("thisComputer"), symbol: m.name ? "server" : undefined,
        active: (m.name ?? null) === this.machine, onClick: (cx) => this.pickMachine(m.name ?? null, cx) }))))
      : this.machine
        ? h_flex().flex_1().min_w(0).items_center().child(machineChip(t, "kb-nw-m-chip", this.machine))
        : div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(this.s("thisComputer"));
    return v_flex().id("kb-nw-root").size_full().min_h(0).p(MENU_PAD)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeDialog(); } })
      .child(h_flex().w_full().h(NEW_HEAD).px(8).flex_none().items_center().text_size(14).font_semibold()
        .text_color(t.foreground).child(this.s("newTitle")))
      .child(h_flex().w_full().h(NEW_FIELD).px(8).gap(8).flex_none().items_center()
        .child(div().w(90).flex_none().text_size(12).text_color(t.dim).child(this.s("newMachine")))
        .child(machine))
      .child(head(this.s("newSpaceLabel")))
      .child(v_flex().id("kb-nw-spaces").w_full().flex_1().min_h(0).gap(2).overflow_y_scrollbar()
        .when(!here.length, (e) => e.child(hint(this.s("newNoSpaces"))))
        .children(here.map((s) => row({ id: `kb-nw-s-${s.id}`, on: s.id === space, label: s.name || base(s.folder) || s.id,
          note: s.branch ?? "", glyph: svg(icon("folder")).size(15).flex_none().text_color(s.id === space ? t.accent : t.muted),
          pick: () => { this.space = s.id; } }))))
      .child(row({ id: "kb-nw-s-new", on: space == null, label: this.s("newSpaceRow"),
        glyph: svg(icon("plus")).size(15).flex_none().text_color(space == null ? t.accent : t.muted),
        pick: (cx) => { this.space = null; this.spaceField.focus(); cx.timer.after(40, () => this.spaceField.focus()); } }))
      .when(space == null, (e) => e.child(field("kb-nw-space-name", "", this.spaceField)))
      .child(head(this.s("newWhatLabel")))
      .child(v_flex().id("kb-nw-what").w_full().flex_1().min_h(0).gap(2).overflow_y_scrollbar()
        .child(row({ id: "kb-nw-a-terminal", on: !this.agent, label: this.s("newTerminal"), tip: this.s("newTerminalTip"),
          glyph: svg(icon("terminal")).size(15).flex_none().text_color(!this.agent ? t.accent : t.muted),
          pick: () => { this.agent = null; } }))
        .when(known == null, (e) => e.child(hint(this.s("newLoading"))))
        .when(known != null && !known.length, (e) => e.child(hint(this.s("newNoAgents"))))
        .children((known ?? []).map((k) => row({ id: `kb-nw-a-${k.key}`, on: this.agent === k.key, label: k.name || k.key,
          glyph: agentGlyph(k, t), pick: () => { this.agent = k.key; } }))))
      .child(field("kb-nw-tab", this.s("newTabLabel"), this.tabField))
      .child(h_flex().w_full().h(NEW_FOOT).px(8).pt(8).gap(6).flex_none().items_center().justify_end()
        .when(off, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.blocked)
          .child(this.s("newUnreachable", { name: this.machine ?? this.s("thisComputer") }))))
        .child(button(t, "kb-nw-cancel", this.s("cancel"), () => this.closeDialog()))
        .child(button(t, "kb-nw-start", this.s("newStart"), () => this.startNew(), { primary: true, symbol: "plus", disabled: off })));
  }

  dialogToSide() {
    this.closeDialog();
    const tab = this.props.tab;
    if (tab?.mod) {
      showTab(tab.mod, tab.name);
      if (find(layout(), "detail")) this.showDetail(); // the tab panel of the Kanban layout
      return;
    }
    const panel = sidePanel(layout());
    run("layout.select", { stack: "panel-body", child: this.props.panel });
    if (panel) run("layout.show", { id: panel.id });
  }

  /** Herdr calls this when the block goes. For the title row of a dialog: the dialog closed (the close
   *  button, Esc or a click beside it), so the bar stops showing its button as lit. */
  async close() {
    if (this.part !== "panel-title") return;
    liveDialogs().delete(this.overlay);
    const open = shared(KEY_PANEL_DIALOG);
    if (open?.id && open.id === this.overlay) setShared(KEY_PANEL_DIALOG, null);
  }

  // ---- what older versions left in the layout ----------------------------------

  /** Brings a layout of an older version up to date in one layout.set: takes out the shell block (and
   *  unwraps its "board-main" column), drops the Terminals view (unwraps the stack "view" and its
   *  "board-view" row when the stack holds nothing else) and turns the agent block "detail" into the tab panel, its head
   *  in the `lang` of the bar or the board. One attempt per layout; true when it ran layout.set or waits for it. */
  migrate(root) {
    const shell = (c) => c.id === "shell" && c.content?.terminal;
    // A stack "view" with children of the person's own stays a stack; only the Terminals view leaves it.
    const view = (n) => n.id === "view" && n.type === "stack" && (n.children ?? []).every((c) => c.id === "board-view" || c.id === "tabs-view");
    const old = (n) => shell(n) || n.id === "tabs-view" || view(n) || (n.id === "detail" && n.content?.agent)
      || (n.children ?? []).some(old);
    if (!root || !old(root)) return false;
    const name = shared("layout"), tried = this.migrateTry;
    // Until layout.set lands, inject/reconcile would write the old tree back: wait for it, a few renders at most.
    if (tried?.name === name) return ++tried.renders <= MIGRATE_RENDERS && Date.now() - tried.at < MIGRATE_MS;
    this.migrateTry = { name, at: Date.now(), renders: 0 };
    const langOf = (n) => (n.content?.mod === "kanban" && ["bar", "board"].includes(n.content.props?.part) && n.content.props.lang)
      || (n.children ?? []).reduce((l, c) => l || langOf(c), null);
    const lang = langOf(root);
    const fix = (node) => {
      if (node.id === "detail" && node.content?.agent) {
        const { content, ...rest } = node, children = JSON.parse(JSON.stringify(TAB_PANEL));
        if (lang) children[0].content.props.lang = lang;
        return { ...rest, type: "column", resizable: false, children };
      }
      if (!Array.isArray(node.children)) return node;
      node.children = node.children
        .flatMap((c) => (view(c) ? (c.children ?? []).flatMap((v) => (v.id === "board-view" ? v.children ?? [] : [v])) : [c]))
        .filter((c) => !shell(c) && c.id !== "tabs-view").map(fix);
      if (node.type === "stack" && node.active === "tabs-view") node.active = node.children[0]?.id;
      return node.id === "board-main" && node.children.length === 1 ? node.children[0] : node;
    };
    try { run("layout.set", { layout: fix(JSON.parse(JSON.stringify(root))) }); } catch (e) {
      console.log(`kanban: migrate: ${e?.message ?? e}`);
      this.migrateTry.renders = MIGRATE_RENDERS; // it will not land: no wait
    }
    return true;
  }

  /** Removes the kanban-shell terminal of older versions once it has ended; a live one may still run
   *  something of the person's, so it stays. */
  async endShell() {
    try {
      const out = (await hc(["get", OLD_SHELL, "--json"]))?.stdout?.trim();
      if (!out) return;
      let info;
      try { info = JSON.parse(out); } catch { return; }
      if (info?.labels?.["kanban.shell"] !== "1") return;
      if (info.state === "live") {
        console.log(`kanban: ${OLD_SHELL} of an older version still runs; end it with \`hc kill ${OLD_SHELL}\`.`);
        return;
      }
      await hc(["rm", OLD_SHELL]);
    } catch (e) { console.log(`kanban: endShell: ${e?.message ?? e}`); }
  }

  // ---- the board -------------------------------------------------------------

  glyph(a, t, compact = false) {
    const prog = (a.term ? null : a.program) ?? {};
    const tile = prog.tile || tint(t.foreground, "14");
    const inner = prog.icon
      ? (prog.tint ? svg(prog.icon).size(compact ? 13 : 15).text_color(prog.color || t.foreground) : image(prog.icon).size(compact ? 15 : 17))
      : svg(icon(a.term ? "terminal" : "bot")).size(compact ? 13 : 15).text_color(t.muted);
    return div().size(compact ? 24 : 28).rounded(compact ? 8 : 9).flex_none().flex().items_center().justify_center().bg(tile).child(inner);
  }

  /** The status mark at the right of a card: it moves for working and for needs you. */
  mark(a, t) {
    const color = statusColor(t, a.status);
    if (a.status === "working") return svg(icon("spinner")).size(15).flex_none().text_color(color).spin(900);
    if (a.status === WAITING) return svg(icon("hourglass")).size(15).flex_none().text_color(color).loop("opacity", { from: 0.4, to: 1, period: 1800 });
    if (a.status === "blocked") return svg(icon("bell")).size(15).flex_none().text_color(color).loop("opacity", { from: 0.3, to: 1, period: 1100 });
    if (a.status === "done") return svg(icon("check")).size(15).flex_none().text_color(color);
    return svg(icon("moon")).size(14).flex_none().text_color(t.dim);
  }

  /** A card of 2 lines: the program icon, the space and the status mark, then the title, with no
   *  age so the title has room. The icon tells the program, so the space names the card. While the
   *  pointer is on the card, its buttons show at the end of the title line. */
  summaryCard(a, t, compact = false) {
    const color = statusColor(t, a.status);
    const pane = panes().find((p) => p.pane === a.pane);
    const selected = a.tab === this.shown;
    const hot = a.status === "blocked";
    const name = a.program?.name || a.app || "Agent";
    const { text: title } = this.cardTitle(a, name);
    // The tab (or the agent's title) names the card; the space goes under it.
    const hasTitle = Boolean(title) && title !== name;
    const head = hasTitle ? title : a.space_name || name;
    // A waiting agent says what it waits for, in place of its space.
    const line = a.wait ? this.waitText(a)
      : hasTitle && a.space_name ? a.space_name : [name, pane?.branch].filter(Boolean).join(" · ");
    const over = this.hoverCard === a.address;
    const machine = machineOf(a);
    const small = (id, symbol, action, tooltip, active = false) => iconButton(t, `${id}-${a.address}`, symbol, action,
      { active, tooltip, size: 20, glyph: 11, color: active ? t.accent : t.dim });
    // Line 1 has the 20 px icon, the machine chip, the pin and the mark beside the head; line 2 is the whole width.
    const inner = this.cardInner(compact, 9);
    const beside = 20 + 7 + (machine ? machineChipW(machine) + 7 : 0) + (a.pinned ? 11 + 7 : 0) + MARK_W + 7;
    const fitHead = fitText(head, inner === null ? null : inner - beside, { max: 13, min: 11, lines: 2, bold: true });
    const fitLine = fitText(line, inner, { max: 11, min: 10, lines: 1 });

    return v_flex().id(`card-${a.address}`).w_full().flex_none().px(9).py(7).gap(4).rounded(9).cursor_pointer()
      .bg(selected ? t.raised : t.background)
      .border_1().border_color(selected ? t.accent : hot ? tint(color, "99") : machine ? tint(remoteColor(t), "88") : t.border)
      .when(selected || hot, (e) => e.shadow_md())
      .hover((s) => s.bg(t.raised))
      .on_hover((hovered, cx) => {
        const next = hovered ? a.address : this.hoverCard === a.address ? null : this.hoverCard;
        if (next !== this.hoverCard) { this.hoverCard = next; cx.notify(); }
      })
      .on_click(() => this.select(a))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openCardMenu(a); })
      .child(h_flex().gap(7).items_center()
        .child(this.glyph(a, t, true).size(20).rounded(6))
        .child(div().flex_1().min_w(0).text_size(fitHead.size).font_bold().text_color(t.foreground)
          .when(fitHead.text !== head, (e) => e.id(`head-${a.address}`).tooltip(head)).child(fitHead.text))
        .when(Boolean(machine), (e) => e.child(machineChip(t, `machine-${a.address}`, machine, { height: 18, text: 10.5 })))
        .when(a.pinned && !over, (e) => e.child(svg(icon("pin")).size(11).flex_none().text_color(t.accent)))
        .child(this.mark(a, t)))
      .child(h_flex().h(20).gap(4).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(fitLine.size).text_color(t.muted).child(fitLine.text))
        .when(over, (e) => e
          .when(Boolean(a.wait), (e) => e.child(small("notwait", "check", () => this.dismissWaiting(a), this.s("notWaiting"))))
          .when(this.namer && !offMods().has("tab-namer"), (e) => e.child(small("rename", "pencil", () => this.openNamer(a), this.s("rename"))))
          .child(small("clone", "copy", () => this.openClone(a), this.s("duplicate")))
          .child(small("pin", "pin", () => this.togglePin(a), this.s(a.pinned ? "unpin" : "pin"), a.pinned))));
  }

  /** The width (px) inside a card of padding `pad` in a place of the board (this.placeW), or null before
   *  the board knows its width: the column border, the side padding of the cards, the card border. */
  cardInner(compact, pad) {
    if (typeof this.placeW !== "number") return null;
    return this.placeW - 2 - 2 * (compact ? 7 : 10) - 2 - 2 * pad;
  }

  /** The title of a card: the name of its tab when a person named the tab (not a number, not the
   *  program name that the launcher gives), else the agent's own title. `named` tells which. */
  cardTitle(a, programName) {
    const tabName = String(a.tab_name ?? "").trim();
    const named = Boolean(tabName) && !unnamed(tabName) && tabName !== programName;
    return named ? { text: tabName, named, agentTitle: (a.title || "").trim() } : { text: (a.title || "").trim(), named };
  }

  /** The tab-namer dialog for the tab of this agent. */
  openNamer(a) {
    openOverlay({ mod: "tab-namer", kind: "dialog", width: 460, props: { tab: a.tab, terminal: a.address, lang: this.lang } });
  }

  /** "2 subagents", "1 subagent · 1 command", or "1 command · Run the tests" when there is only one job
   *  and it has a description. */
  waitText(a) {
    const shells = a.wait.items.filter((p) => p.kind === "shell").length;
    const parts = [];
    if (a.wait.count - shells > 0) parts.push(this.s("subagents", a.wait.count - shells));
    if (shells > 0) parts.push(this.s("commands", shells));
    const first = a.wait.items[0]?.description;
    if (first && a.wait.count === 1) parts.push(first);
    return parts.join(" · ");
  }

  card(a, t, compact = false) {
    const color = statusColor(t, a.status);
    const pane = panes().find((p) => p.pane === a.pane);
    const tab = spaces().find((p) => p.id === a.space)?.tabs.find((x) => x.id === a.tab);
    const since = a.status === "working" ? tab?.working_since ?? tab?.changed_at : tab?.changed_at;
    const selected = a.tab === this.shown;
    const hot = a.status === "blocked";
    const name = a.program?.name || a.app || "Agent";
    // A tab that a person named gives the card its title (the agent's own title goes to the tooltip).
    const { text: title, named, agentTitle } = this.cardTitle(a, name);
    const hasTitle = Boolean(title) && title !== name;
    const head = hasTitle ? title : a.space_name || name;
    const branch = pane?.branch || null;
    // The head shares its row with the program tile and the mark; the space line is the whole width.
    const inner = this.cardInner(compact, compact ? 9 : 12);
    const fitHead = fitText(head, inner === null ? null : inner - (compact ? 24 : 28) - 2 * (compact ? 7 : 9) - MARK_W,
      { max: compact ? 14 : 15, min: 11, lines: 3, bold: true });
    const fitSpace = fitText(a.space_name, inner, { max: 12, min: 10.5, lines: 2 });
    const folder = base(pane?.cwd);
    const machine = machineOf(a);

    return v_flex().id(`card-${a.address}`).w_full().flex_none().p(compact ? 9 : 12).gap(compact ? 7 : 9).rounded(compact ? 10 : 12).cursor_pointer()
      .bg(selected ? t.raised : t.background)
      .border_1().border_color(selected ? t.accent : hot ? tint(color, "99") : machine ? tint(remoteColor(t), "88") : t.border)
      .when(selected || hot, (e) => e.shadow_md())
      .hover((s) => s.bg(t.raised))
      .on_click(() => this.select(a))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openCardMenu(a); })
      .when(a.status === "working", (e) => e.child(
        div().h(2).w_full().rounded(1).bg(color).loop("opacity", { from: 0.2, to: 1, period: 1400 })))
      .child(h_flex().gap(compact ? 7 : 9).items_center()
        .child(this.glyph(a, t, compact))
        // The tab names the card (people name tabs after their work; many cards share a space). Without
        // a title, the space does. Up to 2 lines: an agent's own title can be long.
        .child(v_flex().flex_1().min_w(0)
          .child(div().id(`title-${a.address}`).text_size(fitHead.size).font_bold().text_color(t.foreground)
            .when(fitHead.text !== head, (el) => el.tooltip(head))
            .when(fitHead.text === head && named && Boolean(agentTitle) && agentTitle !== title, (el) => el.tooltip(agentTitle))
            .child(fitHead.text))
          .when(head !== name, (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(name))))
        .child(this.mark(a, t)))
      .when(hasTitle && Boolean(a.space_name), (e) => e.child(
        div().text_size(fitSpace.size).text_color(t.muted).child(fitSpace.text)))
      .child(h_flex().flex_wrap().gap(5).items_center()
        .when(Boolean(machine), (e) => e.child(machineChip(t, `machine-${a.address}`, machine)))
        .when(Boolean(a.wait), (e) => e.child(pill(t, { label: this.waitText(a), symbol: "hourglass", color })))
        .when(Boolean(branch), (e) => e.child(pill(t, { label: branch, symbol: "branch", code: true })))
        // No pill that repeats the head of the card (the space, the program) or the branch.
        .when(Boolean(folder) && folder !== branch && folder !== a.space_name, (e) => e.child(pill(t, { label: folder, symbol: "folder" }))))
      .child(h_flex().h(22).gap(2).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.age(since)))
        .when(Boolean(a.wait), (e) => e.child(iconButton(t, `notwait-${a.address}`, "check", () => this.dismissWaiting(a),
          { tooltip: this.s("notWaiting"), size: 22, glyph: 12, color: t.dim })))
        .when(this.namer && !offMods().has("tab-namer"), (e) => e.child(iconButton(t, `rename-${a.address}`, "pencil", () => this.openNamer(a),
          { tooltip: this.s("rename"), size: 22, glyph: 12, color: t.dim })))
        .child(iconButton(t, `clone-${a.address}`, "copy", () => this.openClone(a),
          { tooltip: this.s("duplicate"), size: 22, glyph: 12, color: t.dim }))
        .child(iconButton(t, `pin-${a.address}`, "pin", () => this.togglePin(a),
          { active: a.pinned, tooltip: this.s(a.pinned ? "unpin" : "pin"), size: 22, glyph: 12, color: a.pinned ? t.accent : t.dim })));
  }

  /** The card of a tab with no agent: the terminal icon, the tab name, its space, machine, folder and panes; as a
   *  summary in 2 lines. A click and a right click act as on an agent card; no pin, no duplicate. */
  terminalCard(c, t, compact, summary) {
    const selected = c.tab === this.shown;
    const folder = base(c.cwd);
    const panesLabel = c.panes > 1 ? this.s("panes", c.panes) : null;
    const chip = (opts) => machineChip(t, `machine-term-${c.tab}`, c.machine, opts);
    const root = v_flex().id(`term-${c.tab}`).w_full().flex_none().cursor_pointer()
      .bg(selected ? t.raised : t.background)
      .border_1().border_color(selected ? t.accent : c.machine ? tint(remoteColor(t), "88") : t.border)
      .when(selected, (e) => e.shadow_md())
      .hover((st) => st.bg(t.raised))
      .on_click(() => this.select(c))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openCardMenu(c); });
    const name = (size) => div().flex_1().min_w(0).truncate().text_size(size).font_bold().text_color(t.foreground).child(c.name);
    if (summary) {
      return root.px(9).py(7).gap(4).rounded(9)
        .child(h_flex().gap(7).items_center()
          .child(this.glyph(c, t, true).size(20).rounded(6))
          .child(name(13))
          .when(Boolean(c.machine), (e) => e.child(chip({ height: 18, text: 10.5 }))))
        .child(h_flex().h(20).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
            .child([c.space_name, folder !== c.space_name ? folder : "", panesLabel].filter(Boolean).join(" · "))));
    }
    return root.p(compact ? 9 : 12).gap(compact ? 7 : 9).rounded(compact ? 10 : 12)
      .child(h_flex().gap(compact ? 7 : 9).items_center()
        .child(this.glyph(c, t, compact))
        .child(v_flex().flex_1().min_w(0)
          .child(name(compact ? 14 : 15))
          .when(Boolean(c.space_name), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(c.space_name)))))
      .when(Boolean(c.machine) || Boolean(folder) || Boolean(panesLabel), (e) => e.child(h_flex().flex_wrap().gap(5).items_center()
        .when(Boolean(c.machine), (r) => r.child(chip()))
        .when(Boolean(folder) && folder !== c.space_name, (r) => r.child(pill(t, { label: folder, symbol: "folder" })))
        .when(Boolean(panesLabel), (r) => r.child(pill(t, { label: panesLabel, symbol: "terminal" })))));
  }

  /** An arrow in a column header that moves the column one place left (-1) or right (+1). Dim at the edge. */
  moveButton(t, c, dir, compact = false) {
    const can = this.neighbor(c.id, dir) !== null;
    return iconButton(t, `move-${dir < 0 ? "left" : "right"}-${c.id}`, dir < 0 ? "chevron-left" : "chevron-right",
      () => this.moveColumn(c.id, dir),
      { tooltip: can ? this.s(dir < 0 ? "moveLeft" : "moveRight") : "", size: compact ? 20 : 24, glyph: compact ? 12 : 14, color: can ? t.muted : tint(t.dim, "55") });
  }

  /** The width rules of one place in the row of columns. `fixed`: the board scrolls sideways, so the
   *  place has the minimum width and does not grow. */
  sized(el, compact, fixed) {
    const min = compact ? MIN_COLUMN_COMPACT : MIN_COLUMN, cap = this.maxWidth();
    return fixed ? el.flex_none().w(min) : el.flex_1().min_w(min).when(cap !== null, (e) => e.max_w(cap));
  }

  /** The rounded box of column `c`, tinted with its status color; `urgent`: a stronger border. */
  frame(el, c, t, compact, urgent) {
    const color = statusColor(t, c.id);
    return el.rounded(compact ? 12 : 16).overflow_hidden()
      .border_1().border_color(urgent ? tint(color, "66") : tint(color, "26")).bg(tint(color, "0d"));
  }

  /** The header of column `c`: its tile, its name, the card count, the arrows and the eye. */
  columnHead(c, count, t, compact) {
    const color = statusColor(t, c.id);
    const urgent = c.id === "blocked" && count > 0;
    const tile = div().size(compact ? 22 : 26).rounded(compact ? 7 : 8).flex_none().flex().items_center().justify_center().bg(tint(color, "26"))
      .child(svg(icon(c.symbol)).size(compact ? 12 : 14).text_color(color));
    const btn = compact ? 20 : 24;
    // Compact: the arrows and the eye show only while the pointer is on the header, so the name has room.
    const tools = !compact || this.hoverCol === c.id;
    return h_flex().id(`head-${c.id}`).h(compact ? 40 : 48).flex_none().px(compact ? 8 : 12).gap(compact ? 4 : 9).items_center()
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openColumns(); })
      .when(compact, (e) => e.on_hover((hovered, cx) => {
        const next = hovered ? c.id : this.hoverCol === c.id ? null : this.hoverCol;
        if (next !== this.hoverCol) { this.hoverCol = next; cx.notify(); }
      }))
      .child(urgent ? tile.loop("opacity", { from: 0.55, to: 1, period: 1200 }) : tile)
      .child(div().flex_1().min_w(0).truncate().text_size(compact ? 12 : 13).font_semibold().text_color(t.foreground).child(this.s(c.id)))
      .child(div().h(20).px(compact ? 6 : 8).flex_none().rounded(10).flex().items_center().text_size(11).font_semibold()
        .bg(tint(color, "26")).text_color(color).child(String(count)))
      .when(tools, (e) => e
        .child(this.moveButton(t, c, -1, compact))
        .child(this.moveButton(t, c, 1, compact))
        .child(iconButton(t, `hide-${c.id}`, "eye-off", () => this.toggleColumn(c.id), { tooltip: this.s("hide"), size: btn, glyph: compact ? 12 : 14, color: t.dim })));
  }

  /** Hidden column `c` in the row of columns: a dim box as tall as a head with its icon and card count; a click shows it. */
  stub(c, count, t, compact) {
    const color = statusColor(t, c.id);
    return v_flex().id(`stub-${c.id}`).w(STUB_W).h(compact ? 42 : 50).flex_none().items_center().justify_center().gap(compact ? 2 : 4)
      .rounded(compact ? 12 : 16).cursor_pointer().border_1().border_dashed().border_color(tint(color, "44"))
      .text_size(10).font_semibold().text_color(t.dim).hover((s) => s.bg(t.hover))
      .tooltip(this.s("showCol", { name: this.s(c.id) }))
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleColumn(c.id); })
      .child(svg(icon(c.symbol)).size(compact ? 12 : 14).text_color(tint(color, "88")))
      .child(String(count));
  }

  /** The cards of `list` in `el`, with the padding and the gap of a compact or normal board. */
  cardStack(el, list, t, compact, summary) {
    return el.px(compact ? 7 : 10).gap(summary ? 6 : compact ? 7 : 10)
      .children(list.map((a) => (a.term ? this.terminalCard(a, t, compact, summary) : summary ? this.summaryCard(a, t, compact) : this.card(a, t, compact))));
  }

  /** One status column. `compact`: smaller header and cards. `fixed`: see sized().
   *  `stacked`: the column shares its place with another column, one under the other. */
  column(c, list, t, searching, { compact = false, fixed = false, stacked = false, summary = false } = {}) {
    const color = statusColor(t, c.id);
    const box = v_flex().id(`col-${c.id}`).min_h(0);
    return this.frame(stacked ? box.w_full().flex_1() : this.sized(box.h_full(), compact, fixed), c, t, compact, c.id === "blocked" && list.length > 0)
      .child(this.columnHead(c, list.length, t, compact))
      .child(this.cardStack(v_flex().id(`scroll-${c.id}`).flex_1().min_h(0).overflow_y_scrollbar().pb(compact ? 7 : 10), list, t, compact, summary)
        .when(list.length === 0, (e) => e.child(
          v_flex().h(compact ? 64 : 96).flex_none().items_center().justify_center().gap(compact ? 4 : 8).rounded(12)
            .border_1().border_dashed().border_color(tint(color, "44"))
            .child(svg(icon(c.symbol)).size(18).text_color(tint(color, "88")))
            .child(div().px(8).text_center().text_size(12).text_color(t.dim)
              .child(this.s(searching ? "emptyColSearch" : c.id === TERMINALS ? "emptyTerminals" : "emptyCol"))))));
  }

  emptyState(t, title, hint, action) {
    return v_flex().size_full().items_center().justify_center().gap(12).p(24)
      .child(div().size(52).rounded(16).flex().items_center().justify_center().bg(tint(t.accent, "1f"))
        .child(svg(icon("board")).size(26).text_color(t.accent)))
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().max_w(380).text_size(12).text_color(t.dim).text_center().child(hint))
      .child(action);
  }

  board(t) {
    const hidden = this.hidden();
    // A search or a filter: an empty column says "No match".
    const searching = String(shared(KEY_QUERY) ?? "").trim().length > 0 || this.activeFilter().kind !== "all";
    if (!agents().length && !this.terminalCards().length) {
      boardNow().stacks = undefined;
      return this.emptyState(t, this.s("none"), this.s("noneHint"),
        button(t, "kb-new", this.s("newAgent"), () => this.openNew(), { primary: true, symbol: "plus" }));
    }
    const shown = this.visible();
    this.shown = shownTab().id; // the cards of the tab in the panel show as selected
    const all = this.columns(), cols = all.filter((c) => !hidden.has(c.id));
    const ids = cols.map((c) => c.id);
    const by = this.grouping();
    const lanes = this.lanes(shown, ids);
    const stub = (c, compact) => this.stub(c, shown.filter((a) => a.status === c.id).length, t, compact);
    if (!cols.length) {
      setAgentOrder([]);
      boardNow().stacks = undefined;
      return v_flex().size_full().min_h(0).gap(GAP)
        .child(h_flex().id("kb-stubs").flex_none().gap(GAP).overflow_x_scrollbar().children(all.map((c) => stub(c, false))))
        .child(this.emptyState(t, this.s("allHidden"), this.s("allHiddenHint"),
          button(t, "kb-show-all", this.s("showAll"), () => setShared(KEY_HIDDEN, []), { primary: true, symbol: "eye" })).flex_1().min_h(0));
    }
    const compact = this.boardCompact(slotsWidth(slotsOf(all, hidden, []), COLUMN_WIDE, STUB_W, GAP));
    const slots = slotsOf(all, hidden, compact ? GROUPS : []);
    const places = slots.flatMap((s) => (s.place ? [s.place] : []));
    // Herdr's agent.next and agent.prev walk the agent cards in the order they show.
    setAgentOrder(this.cardOrder(shown, places, lanes).filter((a) => !a.term).map((a) => a.address));
    // A row that scrolls sideways lays its children out at their content width, so the columns
    // would not share the board. Scroll only when the places do not fit at their minimum width,
    // and then give each place exactly that width.
    const min = compact ? MIN_COLUMN_COMPACT : MIN_COLUMN, gap = compact ? GAP_COMPACT : GAP;
    const width = slotsWidth(slots, min, STUB_W, gap);
    const fixed = typeof this.boardW === "number" && this.boardW < width;
    // The width of one place, as sized() gives it: the cards fit their text to it (see fitText).
    const placeCount = slots.filter((s) => s.place).length;
    const free = typeof this.boardW === "number"
      ? (this.boardW - (slots.length - placeCount) * STUB_W - (slots.length - 1) * gap) / Math.max(1, placeCount) : null;
    const cap = this.maxWidth();
    this.placeW = fixed ? min : free === null ? null : cap !== null ? Math.min(free, cap) : free;
    const opts = { compact, fixed, summary: this.summary(compact) };
    if (lanes) return this.laneBoard(t, lanes, by, slots, shown, searching, { ...opts, gap, width, stub });
    return h_flex().id("kb-columns").size_full().min_h(0).gap(gap)
      .when(fixed, (e) => e.overflow_x_scrollbar())
      .children(slots.map((s) => (s.stub ? v_flex().h_full().flex_none().child(stub(s.stub, compact))
        : s.place.length === 1 ? this.column(s.place[0], inColumn(shown, s.place[0].id), t, searching, opts)
          : this.sized(v_flex().id(`place-${s.place[0].id}`).h_full().min_h(0).gap(gap), compact, fixed)
            .children(s.place.map((c) => this.column(c, inColumn(shown, c.id), t, searching, { ...opts, stacked: true }))))));
  }

  /** The board in lanes: the column heads once on top, under them the lanes, which scroll as one list.
   *  A lane row has the slots of the board, as wide as the heads (an empty spot under a hidden column), and grows
   *  with its tallest column. */
  laneBoard(t, lanes, by, slots, shown, searching, { compact, fixed, summary, gap, width, stub }) {
    const folded = this.collapsed();
    // A row that does not center its children: the boxes of a row stretch to its height.
    const row = () => div().flex().flex_none().gap(gap).when(fixed, (e) => e.w(width)).when(!fixed, (e) => e.w_full());
    // A place holds one box, or (compact) the boxes of a group one under the other; the last takes what is left.
    const place = (p, box) => (p.length === 1 ? this.sized(box(p[0]), compact, fixed)
      : this.sized(v_flex().gap(gap), compact, fixed)
        .children(p.map((c, i) => (i === p.length - 1 ? box(c).w_full().flex_1() : box(c).w_full().flex_none()))));
    // Top-aligned, so a single head does not stretch to a compact pair.
    const heads = row().items_start().children(slots.map((s) => (s.stub ? stub(s.stub, compact) : place(s.place, (c) => {
      const count = inColumn(shown, c.id).length;
      return this.frame(v_flex().id(`col-${c.id}`), c, t, compact, c.id === "blocked" && count > 0).child(this.columnHead(c, count, t, compact));
    }))));
    const cols = slots.flatMap((s) => s.place ?? []);
    const lane = (g) => {
      const shut = folded.has(g.id);
      const label = by === "machine" ? (g.machine ? null : this.s("thisComputer"))
        : g.space ? g.space.name || base(g.space.folder) || g.space.id : this.s("other");
      return v_flex().w_full().flex_none().gap(compact ? 4 : 6)
        .child(this.laneHead(g, label, cols, t, shut))
        .when(!shut, (e) => e.child(row().children(slots.map((s) => (s.stub ? div().w(STUB_W).flex_none() : place(s.place, (c) => {
          const list = inColumn(g.agents, c.id);
          return this.frame(this.cardStack(v_flex().py(compact ? 7 : 10), list, t, compact, summary), c, t, compact, c.id === "blocked" && list.length > 0);
        }))))));
    };
    return v_flex().id("kb-board").size_full().min_h(0).gap(gap)
      .when(fixed, (e) => e.overflow_x_scrollbar())
      .child(heads)
      .child(v_flex().id("kb-lanes").flex_1().min_h(0).overflow_y_scrollbar().gap(compact ? 8 : 12)
        .when(fixed, (e) => e.w(width))
        .children(lanes.map(lane))
        .when(lanes.length === 0, (e) => e.child(div().w_full().py(24).text_center().text_size(12).text_color(t.dim)
          .child(this.s(searching ? "emptyColSearch" : "emptyCol")))));
  }

  /** The head of a lane: a chevron that folds it, its name and machine, its card count; folded, a dot and a count per status. */
  laneHead(g, label, cols, t, shut) {
    return h_flex().id(`lane-${g.id}`).h(30).w_full().flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .bg(tint(t.foreground, "0a")).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleLane(g.id); })
      .child(svg(icon(shut ? "chevron-right" : "chevron-down")).size(14).flex_none().text_color(t.muted))
      .when(Boolean(label), (e) => e.child(div().flex_shrink(1).min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(label)))
      .when(Boolean(g.machine), (e) => e.child(machineChip(t, `lane-machine-${g.id}`, g.machine)))
      .child(div().h(20).px(8).flex_none().rounded(10).flex().items_center().text_size(11).font_semibold()
        .bg(tint(t.foreground, "14")).text_color(t.muted).child(String(g.agents.length)))
      .when(shut, (e) => e.children(cols.map((c) => [c, inColumn(g.agents, c.id).length]).filter(([, n]) => n > 0)
        .map(([c, n]) => h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim)
          .child(div().size(7).rounded(4).flex_none().bg(statusColor(t, c.id)))
          .child(String(n)))));
  }

  // ---- the top bar -------------------------------------------------------------

  /** The buttons of the side panel and of dock/panels.json: Files and Changes, then the entries of the file
   *  in the order listed (side panels and tabs), then its commands but layout.switch. Empty when the layout has
   *  no `panel-body`. `iconOnly`: the names go to the tooltips. Call it once per render: it also edits the layout. */
  panelItems(t, iconOnly = false) {
    const root = layout(), panel = sidePanel(root), body = find(root, "panel-body");
    // One layout edit for each render: what older versions left first, then the place of the tab panel,
    // then the panel edit, then the off mods.
    const dropping = this.migrate(root) || this.placePanel(root);
    if (!panel || !body) { this.maxLater(dropping); return []; }
    // The entries that may use the panel stack: not the id of any other node of the layout.
    const taken = ids(root);
    for (const c of body.children ?? []) taken.delete(c.id);
    const live = this.liveEntries();
    const usable = live.filter((e) => e.opens !== "command" && !taken.has(e.id) && !PANELS.some((p) => p.id === e.id));
    const injecting = !dropping && this.loaded ? this.inject(root, body, usable.filter((e) => e.opens === "panel")) : false;
    const reconciling = !dropping && !injecting && this.reconcile(root);
    this.maxLater(dropping || injecting || reconciling);
    // A panel dialog that shows a mod that is now off closes.
    const openDialog = shared(KEY_PANEL_DIALOG);
    if (openDialog?.id && liveDialogs().has(openDialog.id)) {
      const entry = this.entries.find((e) => e.id === openDialog.panel);
      if (entry && offMods().has(entryMod(entry))) { closeOverlay(openDialog.id); setShared(KEY_PANEL_DIALOG, null); }
    }
    const present = new Set((body.children ?? []).map((c) => c.id));
    const inDialog = this.dialogPanel();
    const lit = (id) => (!panel.hidden && body.active === id) || inDialog === id;
    const tip = (name) => this.s("panelTip", { name });
    // The panels of a group share one button, in the place of the first one; its menu lists them.
    const items = [
      ...PANELS.filter((p) => present.has(p.id)).map((p) => ({ ...p, key: `kb-panel-${p.id}`, on: lit(p.id), tip: tip(p.label) })),
      ...usable.filter((e) => e.opens === "tab" || present.has(e.id)).map((e) => e.opens === "tab"
        ? { ...e, key: `kb-tab-open-${e.id}`, on: inDialog === e.id, tip: "" }
        : { ...e, key: `kb-panel-${e.id}`, on: lit(e.id), tip: tip(e.label) }),
      ...live.filter((e) => e.opens === "command" && e.run !== "layout.switch").map((e) => ({ ...e, key: `kb-cmd-${e.id}`, on: false, tip: "" })),
    ];
    // The person's order and hidden buttons (KEY_BUTTONS) apply to the folded buttons: a group moves as one button.
    // The group menus and the keys still reach a hidden button.
    const prefs = barButtons(), off = new Set(prefs.hidden);
    const folded = arrange(foldGroups(items).map((it) => ({ ...it, id: buttonId(it), entryId: it.id })), prefs.order);
    this.groups = new Map(folded.filter((it) => it.members).map((g) => [g.group, g.members]));
    this.buttonItems = folded.map((it) => (it.members ? { id: it.id, ...this.groupInfo(it.group) } : { id: it.id, label: it.label, icon: it.icon }));
    return folded.filter((it) => !off.has(it.id)).map((it) => {
      if (!it.members) return panelButton(t, it.key, it.icon, it.label, it.on, () => this.togglePanel(it.entryId), it.tip, iconOnly);
      const info = this.groupInfo(it.group);
      return panelButton(t, `kb-group-${it.group}`, info.icon, info.label, it.members.some((m) => m.on), () => this.openGroup(it.group),
        `${info.label}: ${it.members.map((m) => m.label).join(", ")}`, iconOnly, true);
    });
  }

  /** The tab panel, a split button: the button shows or hides it (hiding a maximized panel brings the board back
   *  first), its arrow opens the place menu. The icon shows the place. */
  detailButton(t, iconOnly) {
    const hidden = this.detailHidden();
    return [
      panelButton(t, "kb-detail", icon(PLACE_ICONS[this.panelPlace()]), this.s("agentLabel"), !hidden, () => {
        if (!hidden && this.maximized()) return this.toggleMaximize(true);
        run("layout.toggle", { id: "detail" });
      }, this.s(hidden ? "detailOff" : "detailOn"), iconOnly),
      menuArrow(t, "kb-detail-place", !hidden, () => this.openPlace(), this.s("placeTip")),
    ];
  }

  /** The filter: a funnel with what the board shows (only the funnel in compact), lit while it limits the cards. */
  filterButton(t, iconOnly) {
    const r = this.activeFilter();
    const name = r.space ? spaceName(r.space) : r.kind === "machine" ? r.machine ?? this.s("thisComputer") : "";
    const label = r.kind === "all" || r.kind === "current" ? this.s(r.kind === "all" ? "filterAll" : "filterCurrent") : name.length > 24 ? `${name.slice(0, 23)}…` : name;
    const tip = r.kind === "all" ? this.s("filterAllTip") : this.s(r.kind === "current" ? "filterCurrentTip" : "filterOnlyTip", { name });
    return buttonGroup(t, [panelButton(t, "kb-filter", icon("filter"), label, r.kind !== "all", () => this.openFilter(), tip, iconOnly, true)]);
  }

  /** None / machine / space: how the board splits into lanes. Icons only, the tooltips name them. */
  groupControl(t) {
    const now = this.grouping();
    return segmented(t, GROUPINGS.map((g) => ({ id: `kb-lanes-${g}`, symbol: GROUP_ICONS[g], active: g === now,
      tooltip: this.s(`group_${g}`), onClick: () => setShared(KEY_GROUP, g) })));
  }

  // ---- the agent tree ------------------------------------------------------

  /** The agent the panel shows for tab `id`: the focused terminal when it is in that tab, else the agent an
   *  agent block shows when it is there, else the first agent of the tab. */
  headAgent(id) {
    const fo = focused();
    const inTab = (address) => address && panes().some((p) => p.terminal === address && p.tab === id);
    if (inTab(fo?.terminal)) return fo.terminal;
    if (inTab(fo?.agent)) return fo.agent;
    return agents().find((a) => a.tab === id)?.address ?? null;
  }

  /** A tree node's name: the terminal's own name (hc run --name), else the name of its tab when a person named it,
   *  else its agent's title, else its program. */
  treeLabel(term) {
    if (!term) return "";
    if (term.name) return String(term.name);
    const a = agents().find((x) => x.address === term.address);
    const prog = a?.program?.name || term.program?.name || term.agent || "";
    if (a) {
      const { text } = this.cardTitle(a, prog);
      if (text) return text;
    }
    return prog || String(term.address);
  }

  /** Shows terminal `address`: its tab and pane when it has one, else a peek over the tab. */
  goTo(address) {
    const pane = panes().find((p) => p.terminal === address);
    if (!pane) return this.guard(() => run("terminal.peek", { terminal: address }));
    const space = spaces().find((sp) => (sp.tabs ?? []).some((x) => x.id === pane.tab));
    const agent = agents().some((a) => a.address === address);
    this.guard(() => Promise.all([space ? run("space.select", { id: space.id }) : null, run("tab.select", { id: pane.tab }),
      run("pane.focus", { terminal: address }), agent ? run("agent.focus", { terminal: address }) : null]));
  }

  /** kanban.tree-up / -down / -next / -prev: moves from the shown agent in its tree. */
  stepTree(dir) {
    const id = shownTab().id, here = id ? this.headAgent(id) : null;
    if (!here) return;
    const to = treeStep(forest(terminals()), here, dir);
    if (to) this.goTo(to);
  }

  /** A status dot of 7 px. */
  treeDot(t, status) {
    return div().size(7).rounded(4).flex_none().bg(statusColor(t, status || "idle"));
  }

  /** The path from the root to the shown agent, always short: the root as a link, then "…" (a button: the agents in
   *  between, see openBetween) when there are any, then the shown agent in bold; "›" between them. */
  crumbs(t, f, path) {
    const sep = () => div().flex_none().text_size(12).text_color(t.dim).child("›");
    const link = (address) => {
      const term = f.byAddr.get(address), label = this.treeLabel(term);
      return h_flex().id(`kb-crumb-${address}`).flex_shrink(1).min_w(0).max_w(150).h(24).px(6).gap(5).items_center().rounded(6)
        .cursor_pointer().hover((st) => st.bg(t.hover)).tooltip(label)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.goTo(address); })
        .child(this.treeDot(t, term?.status))
        .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(label));
    };
    const between = path.slice(1, -1);
    const more = h_flex().id("kb-crumb-more").flex_none().h(24).px(7).items_center().rounded(6).cursor_pointer()
      .text_size(13).font_semibold().text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(this.s("treeBetweenTip", between.length))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openBetween(path); })
      .child("…");
    const out = path.length > 1 ? [link(path[0]), sep()] : [];
    if (between.length) out.push(more, sep());
    const last = f.byAddr.get(path[path.length - 1]);
    out.push(h_flex().flex_shrink(1).min_w(0).max_w(260).gap(6).items_center()
      .child(this.treeDot(t, last?.status))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(this.treeLabel(last))));
    return out;
  }

  /** The tree button: a branch icon and the number of children of the shown agent; a click opens the tree menu. */
  treeButton(t, f, root, here) {
    const n = flatten(f, root).length, kids = f.kids.get(here)?.length ?? 0;
    return h_flex().id("kb-tree").flex_none().h(24).px(7).gap(5).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(t.border).text_size(11).text_color(t.muted)
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(`${this.s("treeTip", { n })}${kids ? ` · ${this.s("treeKids", kids)}` : ""}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openTree(); })
      .child(svg(icon("branch")).size(12).flex_none())
      .when(kids > 0, (e) => e.child(String(kids)))
      .child(svg(icon("chevron-down")).size(10).flex_none());
  }

  /** Opens the agents between the root and the shown agent (`path`), top first, as a menu at the pointer. */
  openBetween(path) {
    const between = path.slice(1, -1);
    if (!between.length) return;
    const rows = Math.min(TREE_ROWS, between.length);
    openOverlay({ mod: "kanban", kind: "popup", width: TREE_W, height: MENU_PAD * 2 + MENU_HEAD + rows * MENU_ROW,
      props: { part: "tree-menu", lang: this.lang, root: path[0], here: path[path.length - 1], only: between } });
  }

  /** Opens the tree menu of the shown agent at the pointer. */
  openTree() {
    const id = shownTab().id, here = id ? this.headAgent(id) : null;
    if (!here) return;
    const f = forest(terminals()), root = pathTo(f, here)[0];
    const rows = Math.min(TREE_ROWS, flatten(f, root).length);
    openOverlay({ mod: "kanban", kind: "popup", width: TREE_W, height: MENU_PAD * 2 + MENU_HEAD + rows * MENU_ROW,
      props: { part: "tree-menu", lang: this.lang, root, here } });
  }

  /** The tree menu: the whole tree of the shown agent, indented by depth, live (status dots, names). The shown
   *  agent is lit; one with no pane says so (a click peeks at it). A click goes there and closes the menu. */
  treeMenu(t) {
    const f = forest(terminals()), { root, here, only } = this.props;
    // `only`: just these agents (the ones between the root and the shown agent), indented by their depth.
    const rows = Array.isArray(only) ? only.filter((a) => f.byAddr.has(a)).map((address, i) => ({ address, depth: i + 1 }))
      : flatten(f, root);
    const row = ({ address, depth }) => {
      const term = f.byAddr.get(address), on = address === here;
      const pane = panes().some((p) => p.terminal === address);
      return h_flex().id(`kb-tree-${address}`).w_full().h(MENU_ROW).pr(10).pl(10 + depth * TREE_INDENT).gap(8).flex_none().items_center()
        .rounded(6).cursor_pointer().text_size(13).text_color(on ? t.accent : t.foreground)
        .when(on, (e) => e.bg(tint(t.accent, "1a")).tooltip(this.s("treeHere")))
        .when(!pane, (e) => e.tooltip(this.s("treePeek")))
        .hover((st) => st.bg(on ? tint(t.accent, "33") : t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.goTo(address); if (this.overlay) closeOverlay(this.overlay); })
        .when(depth > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("└")))
        .child(this.treeDot(t, term?.status))
        .child(div().flex_1().min_w(0).truncate().child(this.treeLabel(term)))
        .when(!pane, (e) => e.child(svg(icon("eye")).size(12).flex_none().text_color(t.dim)))
        .when(on, (e) => e.child(svg(icon("tick")).size(13).flex_none().text_color(t.accent)));
    };
    // A popup does not give its content a height to share: the rows get a fixed one and scroll past TREE_ROWS.
    return v_flex().id("kb-tree-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(this.s(Array.isArray(only) ? "treeBetween" : "treeTitle")))
      .child(v_flex().id("kb-tree-rows").w_full().flex_none().h(Math.min(TREE_ROWS, rows.length) * MENU_ROW).overflow_y_scrollbar()
        .children(rows.map(row)));
  }

  /** The head of the tab panel: the tab name, its space and its machine, and the maximize button. */
  tabHead(t) {
    const { space, tab, id } = shownTab();
    const max = this.maximized();
    const toggle = iconButton(t, "kb-head-max", max ? "minimize" : "maximize", () => this.toggleMaximize(),
      { active: max, size: 26, glyph: 14, tooltip: this.s(max ? "restore" : "maximize") });
    const row = h_flex().id("kb-head").size_full().min_w(0).pl(14).pr(5).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border);
    if (!space || !id) {
      return row.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.s("noTab"))).child(toggle);
    }
    // agents() has the name the cards use; a tab with no agent has only its spaces() entry.
    const raw = String(agents().find((a) => a.tab === id)?.tab_name ?? tab?.name ?? "").trim();
    const place = (space.tabs ?? []).findIndex((x) => x.id === id) + 1;
    const name = this.tabLabel(raw, place || raw || id);
    const dot = () => div().flex_none().text_size(12).text_color(t.dim).child("·");
    // In a tree of agents the head shows the path to the shown agent and a tree button; else the tab name.
    const f = forest(terminals()), here = this.headAgent(id);
    const path = here ? pathTo(f, here) : [];
    const inTree = path.length > 1 || (here && (f.kids.get(here)?.length ?? 0) > 0);
    return row
      .when(!inTree, (e) => e.child(div().flex_shrink(1).min_w(0).max_w(260).truncate().text_size(13).font_semibold().text_color(t.foreground).child(name)))
      .when(inTree, (e) => e.children(this.crumbs(t, f, path)).child(this.treeButton(t, f, path[0], here)))
      .child(dot())
      .child(div().flex_shrink(1).min_w(0).truncate().text_size(12).text_color(t.muted).child(space.name || base(space.folder) || space.id))
      .child(dot())
      .child(space.machine ? machineChip(t, "kb-head-machine", space.machine)
        : div().flex_none().text_size(12).text_color(t.dim).child(this.s("thisComputer")))
      .child(div().flex_1())
      .child(toggle);
  }

  /** The value in the width control. With a width set, it is a button that sets Auto again. */
  widthValue(t, cap) {
    const cell = div().w(34).h(24).flex_none().flex().items_center().justify_center().rounded(7).text_size(11).text_color(t.muted);
    if (cap === null) return cell.child(this.s("auto"));
    return cell.id("kb-width-auto").tooltip(this.s("toAuto")).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); setShared(KEY_WIDTH, null); })
      .child(String(cap));
  }

  /** [−] 260 [+]: how wide a column may be. Auto lets the columns share the whole board. */
  widthControl(t) {
    const cap = this.maxWidth();
    const atMin = cap === WIDTHS[0], atMax = cap === null;
    return h_flex().id("kb-width").flex_none().gap(1).items_center()
      .tooltip(cap === null ? this.s("widthTip", { w: this.s("auto") }) : `${this.s("widthTip", { w: `${cap} px` })} ${this.s("widthAutoTip")}`)
      .child(iconButton(t, "kb-narrower", "minus", () => this.stepWidth(-1),
        { tooltip: this.s("narrower"), size: 24, glyph: 13, color: atMin ? t.dim : t.muted }))
      .child(this.widthValue(t, cap))
      .child(iconButton(t, "kb-wider", "plus", () => this.stepWidth(1),
        { tooltip: this.s("wider"), size: 24, glyph: 13, color: atMax ? t.dim : t.muted }));
  }

  bar(t) {
    this.steppedTo(); // forgets the last step once the focus has landed or moved elsewhere
    const w = window();
    const wbtn = (id, glyph, action) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click(action).child(glyph);
    const win = w?.platform === "windows";
    // The bar reads left to right: what to show (search, filter, the lanes, the tab panel) | Settings (the gear menu has the
    // look of the board and the bar, and the columns) | New agent | the panel group (Files, Changes, dock entries) and the
    // window buttons. "icons": New agent and the filter as icons, a narrower search; the Agent and panel buttons are icons unless "names".
    const look = this.barLook(), compact = look === "icons", iconOnly = look !== "names";
    const panels = this.panelItems(t, iconOnly); // once per render: it also edits the layout
    const right = h_flex().flex_none().gap(6).items_center()
      .when(panels.length > 0, (e) => e.child(buttonGroup(t, panels)))
      .when(w?.buttons, (e) => e.child(h_flex().flex_none().gap(2).items_center()
        .child(wbtn("kb-min", win ? svg(icon("win-min")).size(16) : "−", () => run("window.minimize")))
        .child(wbtn("kb-max", win ? svg(icon(w.maximized ? "win-restore" : "win-max")).size(16) : "□", () => run("window.maximize")))
        .child(wbtn("kb-close", win ? svg(icon("win-close")).size(16) : svg(icon("close")).size(13), () => run("window.close")))));
    const settingsButton = iconButton(t, "kb-settings", "settings", () => this.openGear(),
      { size: 28, tooltip: this.s("settingsTip") });
    const newAgent = button(t, "kb-new", this.s("newAgent"), () => this.openNew(), { primary: true, symbol: "bot", iconOnly: compact });
    const search = h_flex().flex_none().gap(4).items_center()
      .child(searchBox(t, "kb-search", this.query, {
        width: compact ? 150 : 220,
        onClear: () => { this.query.set_value(""); setShared(KEY_QUERY, ""); },
      }))
      .child(this.filterButton(t, compact));
    // The search, the filter, the lanes and the Agent button share one row that scrolls sideways when the bar is too narrow
    // (Names on a small monitor). New agent and the right end stay outside it, so they always show.
    const scroller = (children) => h_flex().id("kb-strip").flex_1().min_w(0).gap(compact ? 6 : 10).items_center().overflow_x_scrollbar().children(children);

    // With the sidebar hidden, the macOS window buttons sit over the start of the bar: leave them room.
    const lights = w?.platform === "macos" && find(layout(), "sidebar")?.hidden ? 76 : 0;
    return h_flex().id("kb-bar").size_full().min_w(0).pl(lights > 0 ? lights : compact ? 10 : 14).pr(10).gap(compact ? 6 : 10).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size, cx) => {
        const width = Math.round(size.width);
        if (width !== this.barW) { this.barW = width; cx.notify(); }
      })
      .child(scroller([search, this.groupControl(t), buttonGroup(t, this.detailButton(t, iconOnly))]))
      // Nothing here stops the press, so the window drags by it also while the strip is full.
      .child(div().w(16).h_full().flex_none())
      .child(settingsButton)
      .child(divider(t))
      .child(newAgent)
      .child(right);
  }

  render(cx) {
    const t = theme();
    if (this.part === "panel-title") return this.panelTitle(t);
    if (this.part === "group-menu") return this.groupMenu(t);
    if (this.part === "clone-menu") return this.cloneMenu(t);
    if (this.part === "card-menu") return this.cardMenu(t);
    if (this.part === "card-rename") return this.renameBox(t);
    if (this.part === "new-dialog") return this.newDialog(t);
    if (this.part === "columns-menu") return this.columnsMenu(t);
    if (this.part === "filter-menu") return this.filterMenu(t);
    if (this.part === "place-menu") return this.placeMenu(t);
    if (this.part === "gear-menu") return this.gearMenu(t);
    if (this.part === "buttons-menu") return this.buttonsMenu(t);
    if (this.part === "tree-menu") return this.treeMenu(t);
    if (this.part === "tab-head") return this.tabHead(t);
    this.syncWaiting(cx);
    if (this.part === "bar") return this.bar(t);
    // A right click that no card or column head takes (empty board, lanes, a hidden column) opens the columns menu.
    return v_flex().id("kanban").size_full().min_h(0).min_w(0).text_color(t.foreground).text_size(13)
      .on_mouse_down("right", () => this.openColumns())
      .on_size_change((size, cx) => {
        const w = Math.round(size.width);
        if (w !== this.boardW) { this.boardW = w; cx.notify(); }
      })
      .child(this.board(t));
  }
}
