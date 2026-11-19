// Plain functions with no Herdr calls: terminal rows to text, the URL under a selection, cookie rules, how a link opens and page metadata.

// Ghostty's default selection-word-chars: a double-click word stops at these.
const WORD_STOPS = new Set([..." \t'\"│`|:;,()[]{}<>$"]);
const URL_RE = /https?:\/\/[^\s<>"'`|\\\u0080-\uffff]+/gi;
const HOST_RE = /^https?:\/\/(?:[^@\/?#\s]*@)?(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?(?:[\/?#]|$)/i;
const TRAILING = ".,;:!?'\"";
const PAIRS = { ")": "(", "]": "[", "}": "{", ">": "<" };
const MAX_JOIN = 4;

// [first, last] code points that take two cells: CJK, Hangul, fullwidth forms and emoji.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

/** Cells a code point takes: 0 for combining marks and joiners, 2 for wide ones, else 1. */
export function charWidth(cp) {
  if (cp < 0x300) return cp < 0x20 ? 0 : 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  for (const [a, b] of WIDE) { if (cp < a) return 1; if (cp <= b) return 2; }
  return 1;
}

/** The cells of one logical line wrapped at `cols`: each code point's string span, row and column. */
export function placeLine(line, cols) {
  const cells = [];
  let row = 0, col = 0;
  for (let i = 0; i < line.length;) {
    const cp = line.codePointAt(i), n = cp > 0xffff ? 2 : 1, w = charWidth(cp);
    if (w === 0) {
      if (cells.length) cells[cells.length - 1].end = i + n;
      i += n;
      continue;
    }
    if (col + w > cols) { row++; col = 0; }
    cells.push({ start: i, end: i + n, row, col, w });
    col += w;
    i += n;
  }
  return { cells, rows: row + 1 };
}

/** Whether a wrapped line fills its last row to the edge (a program may have broken it there by hand). */
function fillsLastRow(placed, cols) {
  const last = placed.cells[placed.cells.length - 1];
  return Boolean(last) && last.col + last.w === cols;
}

const ordered = (s) => {
  const { start: a, end: b } = s;
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
};

/**
 * Maps a selection to text: `lines` are logical lines (soft wraps joined, as `hc read` prints them) whose first row is
 * `baseRow`. Returns the selected span in its own line (`line`, `from`, `to`) and in that line joined with neighbours a
 * program broke at the full width (`text`, `start`, `end`), or null when the selection is not on text.
 */
export function selectionText(lines, cols, baseRow, selection) {
  const [from, to] = ordered(selection);
  let row = baseRow;
  for (let li = 0; li < lines.length; li++) {
    const placed = placeLine(lines[li], cols);
    if (from.row >= row && from.row < row + placed.rows) {
      const cell = (r, c) => placed.cells.find((x) => x.row === r - row && x.col <= c && c < x.col + x.w);
      const a = cell(from.row, from.col), b = cell(to.row, to.col);
      if (!a || !b || to.row >= row + placed.rows) return null;
      const line = lines[li];
      let text = line, start = a.start, end = b.end;
      for (let k = li - 1; k >= 0 && li - k <= MAX_JOIN && fillsLastRow(placeLine(lines[k], cols), cols); k--) {
        text = lines[k] + text; start += lines[k].length; end += lines[k].length;
      }
      for (let k = li + 1, last = placed; k < lines.length && k - li <= MAX_JOIN && fillsLastRow(last, cols); k++) {
        text += lines[k];
        last = placeLine(lines[k], cols);
      }
      return { line, from: a.start, to: b.end, text, start, end };
    }
    row += placed.rows;
  }
  return null;
}

/** Whether [start, end) of `text` sits between word stops, as a double-click selects. */
export function isWord(text, start, end) {
  if (end <= start) return false;
  const before = start === 0 ? "" : text[start - 1], after = end >= text.length ? "" : text[end];
  return (!before || WORD_STOPS.has(before)) && (!after || WORD_STOPS.has(after));
}

/** Drops trailing punctuation and closing brackets the URL never opened. */
export function trimUrl(url) {
  let out = url;
  for (;;) {
    const ch = out[out.length - 1];
    if (TRAILING.includes(ch)) { out = out.slice(0, -1); continue; }
    const open = PAIRS[ch];
    if (open && out.split(open).length - 1 < out.split(ch).length - 1) { out = out.slice(0, -1); continue; }
    return out;
  }
}

/** The http(s) URL in `text` that holds all of [start, end), or null. */
export function urlAt(text, start, end) {
  URL_RE.lastIndex = 0;
  for (let m; (m = URL_RE.exec(text));) {
    const url = trimUrl(m[0]);
    if (m.index <= start && end <= m.index + url.length) return HOST_RE.test(url) ? url : null;
  }
  return null;
}

/** The URL a double-click selected, trying rows a few off in case Herdr's view and the core disagree on history. */
export function urlForSelection(lines, cols, baseRow, selection, slack = 3) {
  for (let d = 0; d <= slack; d++) {
    for (const shift of d ? [d, -d] : [0]) {
      const hit = selectionText(lines, cols, baseRow + shift, selection);
      if (!hit || !isWord(hit.line, hit.from, hit.to)) continue;
      const url = urlAt(hit.text, hit.start, hit.end);
      if (url) return url;
    }
  }
  return null;
}

/** The lowercase host of an http(s) URL, without port or credentials. */
export function hostOf(url) {
  const m = HOST_RE.exec(String(url ?? ""));
  return m ? m[1].toLowerCase().replace(/\.$/, "") : null;
}

/** `*.example.com` matches subdomains of example.com; anything else matches that host exactly. */
export function hostMatches(pattern, host) {
  const p = String(pattern ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!p || !host) return false;
  return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
}

// [network, prefix bits]: 0/8, 10/8, 100.64/10 (CGNAT, Tailscale), 127/8, 169.254/16, 172.16/12, 192.168/16.
const PRIVATE_V4 = [[0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16]];
// Names that only resolve on a local or company network.
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "localdomain", "corp", "intranet"];

/** An IPv4 literal as curl reads it (1-4 parts, decimal, octal or hex: `127.1`, `0x7f000001`), or null. */
function ipv4(host) {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    const m = /^(?:0x([0-9a-f]*)|(0[0-7]*)|([1-9][0-9]*))$/i.exec(p);
    if (!m) return null;
    nums.push(m[1] !== undefined ? parseInt(m[1] || "0", 16) : m[2] !== undefined ? parseInt(m[2], 8) : Number(m[3]));
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  return nums.reduce((sum, n, i) => sum + n * 256 ** (3 - i), last);
}

/** The eight 16-bit groups of an IPv6 literal (a trailing dotted quad included), or null. */
function ipv6(text) {
  let s = text;
  const quad = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (quad) {
    const bytes = quad[2].split(".").map(Number);
    if (bytes.some((b) => b > 255)) return null;
    s = `${quad[1]}${(bytes[0] * 256 + bytes[1]).toString(16)}:${(bytes[2] * 256 + bytes[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h) => (h ? h.split(":") : []);
  const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  const zeros = 8 - head.length - tail.length;
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? zeros : 0).fill("0"), ...tail];
  return all.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? all.map((g) => parseInt(g, 16)) : null;
}

const privateV4 = (n) => PRIVATE_V4.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(net / 2 ** (32 - bits)));

/** Whether `host` (as hostOf gives it) is a single-label or local-network name, or a loopback, link-local or private IP literal. */
export function isPrivateHost(host) {
  const h = String(host ?? "").toLowerCase();
  if (!h) return false;
  if (h.startsWith("[") && h.endsWith("]")) {
    const g = ipv6(h.slice(1, -1));
    if (!g) return true; // a literal this cannot read is not fetched either
    // ::a.b.c.d and ::ffff:a.b.c.d carry an IPv4 address (:: and ::1 land in 0/8).
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return privateV4(g[6] * 65536 + g[7]);
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
  }
  const n = ipv4(h);
  if (n !== null) return privateV4(n);
  return !h.includes(".") || PRIVATE_SUFFIXES.some((x) => h === x || h.endsWith(`.${x}`));
}

/** The first cookie rule of the local config whose hosts match `host`, or null. */
export function cookieRule(config, host) {
  const rules = Array.isArray(config?.cookies) ? config.cookies : [];
  return rules.find((r) => Array.isArray(r?.hosts) && typeof r.file === "string" && r.hosts.some((p) => hostMatches(p, host))) ?? null;
}

const inList = (list, host) => Array.isArray(list) && list.some((p) => hostMatches(p, host));

/** Whether `host` matches a pattern of the local config's `askHosts`. */
export function askHost(config, host) {
  return inList(config?.askHosts, host);
}

/** Whether `host` matches a pattern of the local config's `systemBrowserHosts`. */
export function systemHost(config, host) {
  return inList(config?.systemBrowserHosts, host);
}

/**
 * How a link opens: `window` (the browser at once), `ask` (a card that loads nothing, `why`: signin, private, remote,
 * system, listed or ask; `preview: false` when it offers no browser window) or `preview` (the fetched card). `browser`
 * is the browser command or null; `machine` the link's terminal's.
 */
export function linkMode(url, config, { browser = null, machine = null } = {}) {
  const host = hostOf(url);
  const ask = config?.browser === "ask";
  const local = isPrivateHost(host);
  // A private host keeps its own handling: the preview card refuses it, the browser modes give it the private or remote card.
  const system = !local && systemHost(config, host) ? { mode: "ask", why: "system", preview: false } : null;
  if (!ask && (!browser || config?.browser === "card")) {
    if (system) return system;
    return askHost(config, host) ? { mode: "ask", why: "listed", preview: false } : { mode: "preview" };
  }
  const card = (why) => (browser ? { mode: "ask", why } : { mode: "ask", why, preview: false });
  if (local) return card(machine ? "remote" : "private");
  if (system) return system;
  if (cookieRule(config, host)) return card("signin");
  if (askHost(config, host)) return card("listed");
  if (ask) return card("ask");
  return { mode: "window" };
}

/** `url` fit to show beside the link `original`: the original as is, any other without credentials, query or fragment. */
export function shownUrl(url, original) {
  const s = String(url ?? "");
  if (s === original) return s;
  return s.replace(/[?#][\s\S]*$/, "").replace(/^(https?:\/\/)[^@/]*@/i, "$1");
}

const SIGNIN_RE = /(^|[./_-])(log-?in|sign-?in|sso|oauth2?|saml2?|authorize|auth)([./?_#-]|$)/i;

/** Whether a response means the site wants a sign-in: 401/407, or a redirect to another host or a sign-in path. */
export function wantsSignin(requested, final, code, signinHosts = []) {
  if (code === 401 || code === 407) return true;
  const host = hostOf(final);
  if (host && signinHosts.some((p) => hostMatches(p, host))) return true;
  if (!final || final === requested) return false;
  const rest = String(final).replace(/^https?:\/\/[^/?#]*/i, "");
  return (host !== hostOf(requested) && SIGNIN_RE.test(host ?? "")) || SIGNIN_RE.test(rest.split(/[?#]/)[0]);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", copy: "©", reg: "®", trade: "™" };

/** Decodes the HTML entities a title or description uses. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const clean = (s, max) => {
  const t = decodeEntities(String(s ?? "")).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function attrs(tag) {
  const out = {};
  const body = tag.replace(/^<\s*[a-z0-9]+/i, "").replace(/\/?>$/, "");
  const re = /([a-z_:][-a-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  for (let m; (m = re.exec(body));) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** Title, description and site name from the head of an HTML page. */
export function parseHead(html) {
  const src = String(html ?? "");
  const close = src.search(/<\/head\s*>/i);
  const head = (close >= 0 ? src.slice(0, close) : src).slice(0, 400000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  const tag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src.slice(0, 400000));
  return {
    title: clean(meta["og:title"] || meta["twitter:title"] || tag?.[1] || "", 300),
    description: clean(meta["og:description"] || meta["twitter:description"] || meta.description || "", 500),
    site: clean(meta["og:site_name"] || meta["application-name"] || "", 80),
  };
}
