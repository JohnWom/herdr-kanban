// Link Peek: double-click a URL in any terminal and it opens in a browser window, or a card at the pointer.
// One mod, parts chosen by props.part:
//   (none)  the chip in the status bar ("Peek"; a click turns previews on or off) and the selection watcher.
//   "card"  the popup the watcher opens: { url, mode: "preview" | "ask", why?, preview?, machine? }.
//   "bar"   the top bar of the browser window: { terminal, url }.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, panes, spaces, focused, theme, props, shared, setShared, openOverlay, closeOverlay, nextCommand, checking, run, hc } from "herdr";
import { hostOf, linkMode, shownUrl } from "./text.js";
import { urlUnderSelection } from "./resolve.js";
import { preview, loadConfig } from "./fetch.js";
import { browserCommand, openBrowser, endBrowser, showing, sweepBrowsers, LABEL } from "./browser.js";

const KEY_ENABLED = "link-peek.enabled"; // false: off; absent or true: on. The kanban gear menu flips it too.
const DEBOUNCE = 250; // ms the selection must hold still: a triple-click or a drag opens nothing on the way
const SWEEP_AFTER = 3000; // ms after start: a reloaded window's bar has said what it shows by then
const KEEP_WAIT = 3000, KEEP_POLL = 100; // ms terminal.keep may take to give the browser a pane
const MAX_ROWS = 3; // a double-clicked word that wraps spans a few rows; more is a drag
const CARD_W = 440, CARD_H = 214, BODY_H = 94;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const icon = (name) => `mods/link-peek/${name}.svg`;

const enabled = () => shared(KEY_ENABLED) !== false;
const toggle = () => setShared(KEY_ENABLED, !enabled());
const selKey = (s) => `${s.start.row}:${s.start.col}-${s.end.row}:${s.end.col}`;
// The browser's own terminal is left out: a selection there is the page's.
const selections = () => new Map(terminals().filter((t) => t.selection && !t.labels?.[LABEL]).map((t) => [t.address, selKey(t.selection)]));
const machineOf = (address) => (address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null);

function button(t, id, label, glyph, onClick, primary = false) {
  return h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
    .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground))
    .when(!primary, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
    .on_click(onClick)
    .child(svg(icon(glyph)).size(13).flex_none())
    .child(label);
}

// What a card that loads nothing says, by `why`, and what it adds when it offers Open preview.
const ASK = {
  signin: ["Uses your sign-in", () => "Link Peek loads nothing from sites you keep sign-in cookies for.", "Open preview shows the page in a browser window, where you sign in yourself."],
  private: ["Private address", () => "Link Peek loads nothing from local or private-network addresses on its own.", "Open preview shows the page in a browser window."],
  remote: ["On another machine", (m) => `This address points at ${m}. The browser runs on this computer and can't reach it.`],
  listed: ["Not loaded on its own", () => "Link Peek loads nothing from the sites in your askHosts list and never sends them your sign-in."],
  ask: ["Open a preview?", () => "Link Peek loads nothing until you ask.", "Open preview shows the page in a browser window."],
};
const FAILED = ["The browser did not start", () => "Open the link in your browser instead."];

export default class LinkPeek extends View {
  init(given, cx) {
    // A block inside a window gets no `given`: read props() once here, not in later callbacks.
    this.p = given ?? props() ?? {};
    if (this.p.part === "bar") {
      if (this.p.terminal) showing(this.p.terminal, true);
      return;
    }
    if (this.p.part === "card") {
      this.url = String(this.p.url ?? "");
      if (this.p.mode !== "ask") this.load(cx, false);
      return;
    }
    // What is selected at start (or after a reload) is not a double-click; the first render may already be one.
    this.seen = enabled() ? selections() : null;
    this.opened = null;
    this.pending = null;
    if (checking()) return;
    // A browser still starting skips the sweep: try once more.
    cx.timer.after(SWEEP_AFTER, (cx) => sweepBrowsers() || cx.timer.after(SWEEP_AFTER, () => sweepBrowsers()));
    cx.spawn(async (cx) => {
      for (;;) {
        if (String(await nextCommand()) === "toggle") toggle();
        cx.notify();
      }
    });
  }

  /** Ends the browser when its window goes, unless it has a pane: kept as a tab. */
  async close() {
    if (this.p.part !== "bar" || !this.p.terminal) return;
    showing(this.p.terminal, false);
    if (!panes().some((p) => p.terminal === this.p.terminal)) endBrowser(this.p.terminal);
  }

  /** Remembers each terminal's selection; a changed one is looked at once it holds still for DEBOUNCE ms. */
  watch(cx) {
    if (!enabled()) {
      this.seen = null;
      this.pending?.cancel();
      this.pending = null;
      return;
    }
    const now = selections();
    const before = this.seen;
    this.seen = now;
    if (this.opened && now.get(this.opened.address) !== this.opened.sel) this.opened = null;
    // Just turned on: only learn what is selected already.
    if (!before) return;
    const focus = focused()?.terminal;
    let address = null;
    for (const [a, k] of now) if (before.get(a) !== k && (!address || a === focus)) address = a;
    if (!address) return;
    this.pending?.cancel();
    const sel = now.get(address);
    this.pending = cx.timer.after(DEBOUNCE, (cx) => this.check(cx, address, sel));
  }

  check(cx, address, sel) {
    this.pending = null;
    const current = () => terminals().find((x) => x.address === address)?.selection ?? null;
    const s = current();
    if (!enabled() || !s || selKey(s) !== sel || (this.opened?.address === address && this.opened.sel === sel)) return;
    if (Math.abs(s.end.row - s.start.row) >= MAX_ROWS) return;
    cx.spawn(async () => {
      let url = null;
      try { url = await urlUnderSelection(address, s); } catch (e) { console.log(`link-peek: reading ${address} failed: ${e}`); }
      if (!url) return;
      const config = await loadConfig();
      const browser = await browserCommand(config);
      const machine = machineOf(address);
      const how = linkMode(url, config, { browser, machine });
      const still = current();
      if (!enabled() || !still || selKey(still) !== sel) return;
      this.opened = { address, sel };
      // Truthy also when a newer link replaced this one: it shows nothing then.
      if (how.mode === "window" && (await openBrowser(browser, url).catch(() => null))) return;
      const mode = how.mode === "ask" ? "ask" : "preview";
      openOverlay({ mod: "link-peek", kind: "popup", width: CARD_W, height: CARD_H, props: { part: "card", url, mode, why: how.why ?? null, preview: how.preview ?? true, machine } });
    });
  }

  load(cx, fresh) {
    this.state = null;
    cx.spawn(async (cx) => {
      this.state = await preview(this.url, { fresh });
      cx.notify();
    });
  }

  dismiss() {
    if (this.p.overlay) closeOverlay(this.p.overlay);
  }

  openPreview(cx) {
    cx.spawn(async (cx) => {
      const browser = await browserCommand(await loadConfig());
      if (browser && (await openBrowser(browser, this.url).catch(() => null))) return this.dismiss();
      this.failed = true;
      cx.notify();
    });
  }

  /** Whether an ask card offers Open preview. */
  canPreview() {
    return this.p.mode === "ask" && this.p.why !== "remote" && this.p.preview !== false && !this.failed;
  }

  body(t, s) {
    if (this.p.mode === "ask") {
      const [head, text, offer] = this.failed ? FAILED : ASK[this.p.why] ?? ASK.private;
      const said = text(this.p.machine ?? "") + (offer && this.canPreview() ? ` ${offer}` : "");
      return v_flex().h(BODY_H).gap(4).overflow_hidden()
        .child(div().text_size(14).font_semibold().text_color(this.failed ? t.blocked : t.foreground).child(head))
        .child(div().text_size(12).text_color(t.muted).child(said));
    }
    if (!s) {
      return h_flex().h(BODY_H).gap(8).items_center().text_size(13).text_color(t.muted)
        .child(div().w(12).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0]))
        .child(`Loading ${hostOf(this.url) ?? "the page"}…`);
    }
    if (s.error) {
      const head = { signin: "Sign in needed", timeout: "No answer", http: "The page did not load", size: "Too large to preview", private: "Private address: not loaded" }[s.error.kind] ?? "Could not load the page";
      return v_flex().h(BODY_H).gap(4).overflow_hidden()
        .child(div().text_size(14).font_semibold().text_color(t.blocked).child(head))
        .child(div().text_size(12).text_color(t.foreground).child(s.error.message))
        .when(Boolean(s.error.hint), (e) => e.child(div().text_size(12).text_color(t.muted).child(String(s.error.hint))))
        .when(Boolean(s.title) && s.error.kind !== "signin", (e) => e.child(div().truncate().text_size(12).text_color(t.dim).child(s.title)));
    }
    return v_flex().h(BODY_H).gap(4).overflow_hidden()
      .child(div().max_h(40).overflow_hidden().text_size(14).font_semibold().text_color(t.foreground).child(s.title || shownUrl(s.final, this.url)))
      .when(Boolean(s.description), (e) => e.child(div().max_h(50).overflow_hidden().text_size(12).text_color(t.muted).child(s.description)));
  }

  card(t) {
    const s = this.state;
    const ask = this.p.mode === "ask";
    const canPreview = this.canPreview();
    const host = s?.host ?? hostOf(this.url) ?? "";
    const where = s?.site && s.site.toLowerCase() !== host ? `${s.site} · ${host}` : host;
    // Only the link itself is shown whole: a redirect hop or another final URL may carry a token.
    const final = s ? shownUrl(s.final, this.url) : this.url;
    const status = s ? [s.code ? String(s.code) : null, final].filter(Boolean).join(" · ") : this.url;
    return v_flex().id("link-peek-card").size_full().p(12).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(20).gap(8).items_center()
        .child(svg(icon("link")).size(14).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(where))
        .child(div().id("link-peek-close").size(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
          .on_click(() => this.dismiss())
          .child(svg(icon("close")).size(13))))
      .child(this.body(t, s))
      .child(div().h(16).truncate().text_size(11).text_color(t.dim).tooltip(final).child(status))
      .child(h_flex().h(28).gap(8).items_center()
        .when(canPreview, (e) => e.child(button(t, "link-peek-preview", "Open preview", "link", (_e, cx) => this.openPreview(cx), true)))
        .child(button(t, "link-peek-open", "Open in browser", "open", (_e, cx) => { cx.open_url(this.url); this.dismiss(); }, !canPreview))
        .child(button(t, "link-peek-copy", this.copied ? "Copied" : "Copy URL", "copy", (_e, cx) => {
          cx.write_to_clipboard(this.url);
          this.copied = true;
          cx.notify();
        }))
        .when(!ask && Boolean(s?.error) && s.error.kind !== "private", (e) => e.child(button(t, "link-peek-retry", "Retry", "retry", (_e, cx) => this.load(cx, true)))));
  }

  /** Gives the browser a tab of the shown space and closes the window without ending it; ends it when keep fails. */
  keep(cx) {
    const { terminal } = this.p;
    run("terminal.keep", { terminal });
    cx.spawn(async (cx) => {
      const paned = () => panes().some((p) => p.terminal === terminal);
      for (let waited = 0; !paned() && waited < KEEP_WAIT; waited += KEEP_POLL) await cx.sleep(KEEP_POLL);
      if (!paned()) {
        console.log(`link-peek: keeping ${terminal} gave it no pane; ending it`);
        return this.dismiss();
      }
      const r = await hc(["label", terminal, `${LABEL}=kept`]).catch((e) => ({ code: String(e) }));
      // Still labelled browser: the sweeps skip it while it has a pane.
      if (r.code !== 0) console.log(`link-peek: labelling ${terminal} kept failed (hc label: ${r.code})`);
      this.dismiss();
    });
  }

  barButton(t, id, label, tip, onClick) {
    return div().id(id).px(8).py(2).flex_none().rounded(5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      // A press the bar doesn't stop drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  bar(t) {
    const { terminal, url } = this.p;
    const k = terminals().find((x) => x.address === terminal);
    // A terminal on this computer can't be a tab of another machine's space.
    const keepable = Boolean(k) && spaces().find((s) => s.active)?.machine == null && !panes().some((p) => p.terminal === terminal);
    return h_flex().id("link-peek-bar").size_full().px(12).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border).text_size(12)
      .child(svg(icon("link")).size(13).flex_none().text_color(t.accent))
      .child(div().flex_none().max_w(320).truncate().font_semibold().text_color(t.foreground).child(k?.title || hostOf(url) || ""))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(String(url ?? "")))
      .child(this.barButton(t, "link-peek-bar-open", "↗ open", "Open the link in your browser", (_e, cx) => { cx.open_url(url); this.dismiss(); }))
      .when(keepable, (e) => e.child(this.barButton(t, "link-peek-bar-keep", "keep", "Keep the browser as a tab", (_e, cx) => this.keep(cx))))
      .child(this.barButton(t, "link-peek-bar-close", "✕", "Close the browser", () => this.dismiss()));
  }

  chip(t) {
    const on = enabled();
    return h_flex().id("link-peek-chip").size_full().px(10).gap(6).items_center().justify_center().bg(t.chrome)
      .border_t(1).border_color(t.border).text_size(11.8).text_color(on ? t.muted : t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(on ? "Link previews on: double-click a link in a terminal. Click to turn them off." : "Link previews off. Click to turn them on.")
      .on_click(() => toggle())
      .child(svg(icon("link")).size(13).flex_none().text_color(on ? t.accent : t.dim))
      .child("Peek");
  }

  render(cx) {
    const t = theme();
    if (this.p.part === "bar") return this.bar(t);
    if (this.p.part === "card") return this.card(t);
    this.watch(cx);
    return this.chip(t);
  }
}
