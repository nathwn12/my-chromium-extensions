// Reading the packages, never writing them: the harness needs to tell a
// feature that is missing from a feature that is present and wrong.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** True when any top-level .js file in the package mentions the token. */
export function packageMentions(dir, token, { depth = 1 } = {}) {
  const files = depth > 0 ? listScripts(dir, depth) : [];
  for (const file of files) {
    try {
      if (readFileSync(file, "utf8").includes(token)) return true;
    } catch {
      /* an unreadable file cannot vouch for the token */
    }
  }
  return false;
}

function listScripts(dir, depth) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry === "node_modules" || entry === "tests" || entry === "test") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isFile() && /\.(js|mjs)$/.test(entry)) out.push(full);
    else if (stat.isDirectory() && depth > 1) out.push(...listScripts(full, depth - 1));
  }
  return out;
}

/** `match pattern` → host (`*://*.example.com/*` → `*.example.com`).
 * Returns null for `<all_urls>`, the bare wildcard patterns, and anything without a host.
 */
export function patternHost(pattern) {
  const match = /^[a-z*]+:\/\/([^/]+)\//i.exec(String(pattern ?? ""));
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (host === "*" || host === "*/*") return null;
  return host;
}

/** Contract rule: a host matches an exclusion key when it is the key or a subdomain of it. */
export function hostCovers(key, host) {
  const k = String(key ?? "").toLowerCase();
  const h = String(host ?? "").toLowerCase();
  if (!k || !h) return false;
  return h === k || h.endsWith(`.${k}`);
}

/** Does any pattern in the list target this host, directly or through a wildcard? */
export function patternsCoverHost(patterns, host) {
  for (const pattern of patterns ?? []) {
    const patternHostValue = patternHost(pattern);
    if (!patternHostValue) return true; // <all_urls> / *://*/* covers everything
    const bare = patternHostValue.startsWith("*.") ? patternHostValue.slice(2) : patternHostValue;
    if (hostCovers(bare, host) || bare === host) return true;
  }
  return false;
}
