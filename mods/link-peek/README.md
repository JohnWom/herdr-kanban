# Link Peek

Double-click a link in any terminal and the page opens in a browser window over Herdr:
terminal-browser, a real browser that runs in a terminal. The window does not take the
keyboard, so your typing stays where it was; click into it to scroll, type or sign in.
Its bar shows the page title and the link, with **↗ open** (your own browser), **keep**
(the browser as a tab of the shown space; only for a space on this computer) and **✕**.

Some links get a small card at the pointer instead, and Link Peek loads nothing for them:

- a site you keep sign-in cookies for (a host in a cookie rule, below),
- a host in `askHosts` (below), and
- a private address: `localhost`, a name without a dot (`http://intranet/`), `.local`,
  `.internal`, `.lan`, `.home.arpa`, `.localdomain`, `.corp`, `.intranet`, and loopback,
  link-local, private-network and CGNAT (`100.64.0.0/10`, Tailscale) IPs.

With `"browser": "ask"`, every link gets that card and nothing opens on its own; without
terminal-browser the card has no **Open preview** and still loads nothing.

The card shows the host and the link, with **Open preview** (the browser window),
**Open in browser**, **Copy URL** and **Close** (or Esc, or a click beside the card).

Without terminal-browser (unless `browser` is `"ask"`), or with `"browser": "card"`, every
link gets the preview card instead: the page's title, description, site name and host, the
HTTP status and the final URL after redirects, with **Open in browser**, **Copy URL**,
**Close** and **Retry** when the page did not load. A host in `askHosts` still gets the
card that loads nothing, then without **Open preview**.

## Using it

- Double-click any word of the link (`https`, the host, a part of the path). The
  mod extends it to the whole URL and drops trailing punctuation (`.,;:!?'"` and
  closing brackets the URL never opened), so `[docs](https://example.com/p).`
  opens `https://example.com/p`. A link that wraps onto the next row works too.
  In a program that takes the mouse (an agent's screen), Shift+double-click.
- A selection must hold still for 250 ms, so a triple-click or a drag opens nothing
  on the way, and the same selection never opens twice.
- One browser window at a time: another link replaces it and ends the browser it
  showed. Closing the window ends its browser; the browser quitting closes the window.
- **On/off:** the **Peek** chip in the status bar (lit while on), the **Link
  previews** row of the kanban gear menu, or the command `link-peek.toggle`
  (bind it in `keys.json` if you like; no key is bound). The setting is
  `shared("link-peek.enabled")` (`false` is off; absent means on). Off, the mod
  reads no terminal, opens nothing and fetches nothing.
- It runs only while its block is in the shown layout: in the kanban layout, the
  `link-peek` block of the status row.
- A terminal on another machine (`machine/t7`): the browser still runs on this
  computer. A private address from there points at that machine, so its card says the
  browser can't reach it and offers no preview.

## Local settings (optional)

All in `~/.config/herdr-app/data/link-peek.json`. This file is yours and never in the
repository:

```json
{
  "browser": "terminal-browser",
  "browserCommand": "~/.local/bin/terminal-browser",
  "askHosts": ["files.example.net", "*.files.example.net"],
  "cookies": [
    { "hosts": ["*.example.com", "example.com"], "file": "~/.example/cookie", "negotiate": false,
      "hint": "Sign in with example-login, then Retry." }
  ],
  "signinHosts": ["login.example.com"],
  "timeoutSeconds": 8
}
```

- `browser` (optional): `"terminal-browser"` (the default when it is found), `"ask"` (the
  card that loads nothing for every link, found or not; **Open preview** opens the browser
  window when terminal-browser is found) or `"card"` (the preview card for every link).
- `browserCommand` (optional): the path to terminal-browser. Without it the mod looks on
  PATH, then in `~/.local/bin`, since Herdr's PATH may not hold it.
- `askHosts` (optional): hosts, written like a cookie rule's `hosts`, whose links always get
  the card that loads nothing and that never get cookies or Kerberos, not even as a
  redirect hop of a cookie rule's preview. For sites where anyone can host content, or
  whose links carry their own access.
- `cookies` (optional): the sites you keep sign-in cookies for. In browser mode their
  links get the card that loads nothing; the browser has its own sign-in. The rest of
  this list is for the preview card.
- `hosts`: `*.example.com` matches every subdomain of example.com, a plain name only
  that host. The first rule that matches the link's host is used. The mod follows
  redirects itself and sends the cookies and Kerberos only on https requests to a host
  in this list, so list the sign-on host too when its hop needs them.
- `file`: a Netscape cookie file. curl reads it with `-b` and never writes it. Requests
  to http, to hosts outside `hosts`, or for links no rule matches get none of its
  cookies. Cookies a site sets during the redirects are kept for that preview only,
  in a temporary folder only you can read, deleted when it ends.
- `negotiate` (optional): also sign on with Kerberos (`curl --negotiate -u :`), for
  sites whose sign-on hop wants a ticket.
- `hint` (optional): shown under "The site wants you to sign in."; `signinHint` at the
  top level is the hint for links no rule matches.
- `signinHosts` (optional): hosts whose answer always means "sign in". Without them, a
  401 or a redirect to a login, SSO or OAuth page counts as a sign-in request.
- `timeoutSeconds` (optional): how long a preview may take, all redirects included
  (default 8, from 2 to 30).

## What it does on your machine

- On a new selection it runs `hc read <terminal> --lines 0 --json` (the screen; with
  `--lines N` too when the selection is in the history) and finds the URL locally. For
  a terminal outside a pane it reads `--lines 1` first, then the screen if the
  alternate screen is active, else all of the history.
  Remote terminals (`machine/t7`) are read through `hc` the same way.
- It finds terminal-browser with `sh -c 'command -v …'` (or checks that the configured
  path is executable), at most once a minute.
- For the browser window it runs `hc run --bg --json --no-parent --rm --label
  link-peek=browser -- <terminal-browser> open --no-merge <url>` on this computer: a
  terminal with no tab or pane, removed once it ends, that is its own browser instance.
  It shows that terminal in a Herdr window (key `link-peek`) and ends it with
  `terminal.kill` when the window closes or another link replaces it; of two links
  opened at once, the later wins and the other's browser is ended. A few seconds after
  the mod starts, it also ends every `link-peek=browser` terminal on this computer that
  no pane or browser window shows (one a crash, a forced quit or a reload left). **keep**
  runs `terminal.keep`, waits up to 3 seconds for the pane, then runs `hc label <terminal>
  link-peek=kept`, so the tab's browser is never ended; without a pane it ends the browser.
- For the preview card it runs `curl -sS -g --max-redirs 0 --max-filesize 2000000` on
  this computer, http and https only, once per hop, following at most 8 redirects, all
  within the time limit (8 seconds unless `timeoutSeconds` says otherwise). Around them,
  `sh` with `mktemp -d` makes the temporary cookie folder and `rm -rf` deletes it. It
  reads the title and meta tags with regular expressions. Nothing from the page runs.
  Results are cached for 5 minutes (errors for 30 seconds); a restart or a reload empties
  the cache. Cards show and copy only the link you clicked: any other URL (a redirect
  hop, a final URL) is shown without its credentials, query and fragment.
- The preview card does not fetch private addresses, neither as the link nor as a
  redirect: it says "Private address: not loaded". Host names are not resolved, so a
  public name that points to a private address is still fetched, or opened in the
  browser window.
- It reads `data/link-peek.json` and stores one value in `shared()`:
  `link-peek.enabled`. It never logs or shows cookie contents.

## Limits

- Link Peek decides by the host of the link you double-clicked only. Inside the browser
  window the page is a real browser: redirects, images, scripts and frames may reach other
  hosts, private ones included, with terminal-browser's own saved profile (its cookies and
  sign-ins). Use `askHosts` or `"browser": "ask"` where that matters.
- A double-click meant only to copy a link still opens it: a public link is visited at
  once. Turn previews off with the **Peek** chip, or use `"browser": "ask"`.

- Herdr's view of a terminal and herdr-core can disagree on history. The mod anchors
  rows on the active screen (or the top of the alternate screen, where vim and less
  run) and tries a few rows around; a double-click far up in a long history of a
  terminal outside a pane (a peek, a window) may open nothing, and so does one in an
  agent's redrawn screen there (`hc read` says `stitched`).
- `hc read` joins soft-wrapped rows. A URL a program broke into lines by hand is joined
  only when the first line fills the terminal to its last column.
- terminal-browser checks that its terminal can show images as it starts, so the
  window shows its terminal at once; a browser that quits on its own closes the window.
- The preview card shows no images: GPUI's `image()` did not draw a file the mod
  downloaded at run time, so it shows no favicon or `og:image`.
- curl's own user agent is sent. A browser-like one makes some sign-on pages answer
  with a page that needs JavaScript.
- English only.
