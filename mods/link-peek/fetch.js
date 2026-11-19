// The network side: the local config, curl for the page, and a short cache shared by the copies.

import { exec, home, appHome, readTextFile } from "herdr";
import { hostOf, hostMatches, cookieRule, askHost, isPrivateHost, wantsSignin, parseHead } from "./text.js";

export const CONFIG_FILE = "data/link-peek.json";
const PAGE_TTL = 5 * 60000, ERROR_TTL = 30000, CACHE_MAX = 200;
const MAX_REDIRECTS = 8;
const TIMEOUT_DEFAULT = 8, TIMEOUT_MIN = 2, TIMEOUT_MAX = 30;
const MARK = "\n@@link-peek@@";
// No -A: single sign-on layers serve curl's own user agent a redirect flow, and a browser-like one a page that needs JavaScript.
// No -L: fetchPage follows redirects hop by hop, so credentials go only where the rule allows.
// No --compressed: --max-filesize caps the bytes received, not what they decompress to.
const BASE = ["-sS", "-g", "--max-redirs", "0", "--proto", "=http,https", "--max-filesize", "2000000",
  "-H", "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "-o", "-", "-w", `${MARK}%{http_code}\t%{url_effective}\t%{content_type}\t%{redirect_url}`];
const REASONS = { 400: "Bad request", 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 405: "Method not allowed", 408: "Request timeout",
  410: "Gone", 429: "Too many requests", 500: "Server error", 502: "Bad gateway", 503: "Service unavailable", 504: "Gateway timeout" };
const CURL_ERRORS = { 6: "Could not resolve the host", 7: "Could not connect", 35: "TLS handshake failed", 52: "Empty reply from the server",
  56: "The connection broke", 60: "The certificate is not trusted", 63: "The page is larger than 2 MB" };
const PRIVATE = "Link Peek does not fetch loopback, link-local or private-network hosts.";

// Module scope on purpose: every copy of this source version shares the cache.
const pages = new Map();

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

/** The person's local config (never in the repo): `{ cookies: [{ hosts, file, negotiate?, hint? }], askHosts?, systemBrowserHosts?, signinHosts?, signinHint?, timeoutSeconds? }`. */
export async function loadConfig() {
  const text = await readTextFile(`${appHome()}/${CONFIG_FILE}`).catch(() => null);
  if (!text) return {};
  try { return JSON.parse(text) ?? {}; } catch { console.log(`link-peek: ${CONFIG_FILE} is not valid JSON; ignoring it`); return {}; }
}

/** Seconds the whole redirect chain may take: `timeoutSeconds`, clamped. */
function timeoutOf(config) {
  const n = config?.timeoutSeconds;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n)) : TIMEOUT_DEFAULT;
}

/** The cookie rule for the link's host with its file resolved, or null. */
function ruleFor(config, url) {
  const rule = cookieRule(config, hostOf(url));
  return rule && { ...rule, file: rule.file.startsWith("~/") ? `${home()}/${rule.file.slice(2)}` : rule.file };
}

/** Whether a hop gets the rule's cookie file and Kerberos: https, to a host the rule lists and `askHosts` does not. */
const trusted = (config, rule, url) => Boolean(rule) && /^https:\/\//i.test(url) && rule.hosts.some((p) => hostMatches(p, hostOf(url))) && !askHost(config, hostOf(url));

/**
 * curl arguments for one hop. A trusted hop reads the rule's file and keeps Set-Cookie in the `auth` jar; other hops
 * use only the `open` jar, so no cookie from the file or a trusted hop reaches them (curl writes `-b` cookies to `-c`).
 */
function hopArgs(config, rule, url, jars, seconds) {
  let cookies = ["-b", jars.open, "-c", jars.open];
  if (trusted(config, rule, url)) {
    // curl reads a -b value with "=" as cookie text, not as a file name.
    cookies = [...(rule.file.includes("=") ? [] : ["-b", rule.file]), "-b", jars.auth, "-c", jars.auth];
    if (rule.negotiate === true) cookies.push("--negotiate", "-u", ":");
  }
  return [...BASE, "--max-time", seconds.toFixed(1), ...cookies, url];
}

/** A new folder only this user can read, holding two empty cookie jars; null when it cannot be made. */
async function privateDir() {
  const r = await exec("sh", ["-c", 'umask 077 && d=$(mktemp -d "${TMPDIR:-/tmp}/link-peek.XXXXXX") && : > "$d/open" && : > "$d/auth" && printf %s "$d"']);
  const dir = r.code === 0 ? r.stdout.trim() : "";
  return /^\/[^=\n]*\/link-peek\.[A-Za-z0-9]+$/.test(dir) ? dir : null;
}

/** One curl run: the response's code, URL, type, body and redirect target, or `failed` when curl did not run. */
async function runHop(args, seconds) {
  try {
    const r = await exec("curl", args, { timeout: Math.ceil(seconds * 1000) + 3000 });
    const at = r.stdout.lastIndexOf(MARK);
    const [codeText = "0", final = "", type = "", next = ""] = (at >= 0 ? r.stdout.slice(at + MARK.length) : "").split("\t");
    return { r, body: at >= 0 ? r.stdout.slice(0, at) : r.stdout, code: Number(codeText) || 0, final, type, next: next.trim() };
  } catch (e) {
    return { failed: /time/i.test(String(e)) ? "timeout" : "network" };
  }
}

const lastPart = (url) => {
  const part = String(url).split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() || "";
  try { return decodeURIComponent(part); } catch { return part; }
};

async function fetchPage(url, config) {
  const base = { url, final: url, code: 0, type: "", host: hostOf(url), title: "", description: "", site: "", error: null };
  const at = (hop, error, code = 0) => ({ ...base, final: hop, host: hostOf(hop), code, error });
  if (!base.host) return at(url, { kind: "network", message: "Not a web address" });
  if (isPrivateHost(base.host)) return at(url, { kind: "private", message: PRIVATE });
  const seconds = timeoutOf(config);
  const late = { kind: "timeout", message: `Timed out after ${seconds} seconds` };
  const deadline = Date.now() + seconds * 1000;
  const rule = ruleFor(config, url);
  const dir = await privateDir().catch(() => null);
  if (!dir) return at(url, { kind: "network", message: "Could not make a private temporary folder" });
  const jars = { open: `${dir}/open`, auth: `${dir}/auth` };
  try {
    let hop = url, h;
    for (let redirects = 0; ; redirects++) {
      const left = (deadline - Date.now()) / 1000;
      if (left < 0.5) return at(hop, late);
      h = await runHop(hopArgs(config, rule, hop, jars, left), left);
      if (h.failed) return at(hop, h.failed === "timeout" ? late : { kind: "network", message: "Could not run curl" });
      if (h.r.code !== 0 || h.code < 300 || h.code > 399 || !h.next) break;
      if (redirects >= MAX_REDIRECTS) return at(hop, { kind: "network", message: "Too many redirects" }, h.code);
      const host = /^https?:\/\//i.test(h.next) ? hostOf(h.next) : null;
      if (!host) return at(hop, { kind: "network", message: "It redirects to an address that is not a web page" }, h.code);
      if (isPrivateHost(host)) return at(h.next, { kind: "private", message: `It redirects to ${host}. ${PRIVATE}` });
      hop = h.next;
    }
    return finish(base, config, rule, hop, h, late);
  } finally {
    await exec("rm", ["-rf", "--", dir]).catch(() => {});
  }
}

/** The card's result from the last hop's response. */
function finish(base, config, rule, hop, h, late) {
  const { r, body, code } = h;
  const final = h.final || hop;
  const out = { ...base, final, code, type: h.type.split(";")[0].trim().toLowerCase(), host: hostOf(final) };
  if (/html|xml/.test(out.type) || (!out.type && /<html|<head|<title/i.test(body.slice(0, 2000)))) Object.assign(out, parseHead(body));
  else if (out.type) Object.assign(out, { title: lastPart(out.final), description: out.type });
  // A transfer that stopped partway (a timeout on a sign-on hop) is not a sign-in answer.
  if (r.code !== 0 && !(r.code === 63 && code)) {
    if (r.code === 28) return { ...out, error: late };
    const message = CURL_ERRORS[r.code] ?? (r.stderr.split("\n")[0].replace(/^curl: \(\d+\)\s*/, "") || `curl failed (${r.code})`);
    return { ...out, error: { kind: "network", message } };
  }
  const hint = rule?.hint ?? config.signinHint ?? null;
  const signinHosts = Array.isArray(config.signinHosts) ? config.signinHosts : [];
  if (wantsSignin(base.url, out.final, code, signinHosts)) return { ...out, error: { kind: "signin", message: "The site wants you to sign in.", hint } };
  if (code >= 400) return { ...out, error: { kind: "http", message: `HTTP ${code}${REASONS[code] ? ` · ${REASONS[code]}` : ""}` } };
  if (r.code === 63 && !out.title) return { ...out, error: { kind: "size", message: CURL_ERRORS[63] } };
  return out;
}

/** The preview of a URL, from the cache when it is fresh (`fresh` skips the cache). */
export async function preview(url, { fresh = false } = {}) {
  const hit = pages.get(url);
  if (!fresh && hit && Date.now() - hit.at < (hit.result.error ? ERROR_TTL : PAGE_TTL)) return hit.result;
  const result = await fetchPage(url, await loadConfig());
  remember(pages, url, { at: Date.now(), result });
  return result;
}
