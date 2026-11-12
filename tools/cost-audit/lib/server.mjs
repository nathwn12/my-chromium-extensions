// Network-free fixtures: two localhost servers, pages generated in memory, and
// a WAV data URI so audio cases need no file and no fetch.
//
// https exists only so a page can carry a real https origin for the extensions
// whose manifest matches are pinned to https://music.youtube.com/*. Chrome is
// pointed at it with --host-resolver-rules, so no DNS and no external host is
// ever contacted; the certificate is minted into the throwaway profile and
// thrown away with it.

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sineWavDataUri } from "./probe.mjs";

const OPENSSL_CANDIDATES = [
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "openssl",
];

export function findOpenssl({ exists = existsSync } = {}) {
  for (const candidate of OPENSSL_CANDIDATES) {
    if (candidate === "openssl" || exists(candidate)) return candidate;
  }
  return null;
}

/** Mint a throwaway self-signed cert for the mapped host. Returns null if no tooling. */
export function mintCertificate(dir, { host = "music.youtube.com", openssl = findOpenssl() } = {}) {
  if (!openssl) return null;
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync(
      openssl,
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "2", "-subj", `/CN=${host}`,
        "-addext", `subjectAltName=DNS:${host}`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    return { key: readFileSync(keyPath), cert: readFileSync(certPath), host };
  } catch {
    return null;
  }
}

// The page carries no behaviour of its own: one inline script marks itself so
// the probe can prove script-element counting works, and nothing else runs.
// Any listener, timer or observer recorded here therefore came from elsewhere.
function page({ title, media = false, mediaUri = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script>if (window.__costProbe) window.__costProbe.markInlineScript();</script>
</head>
<body>
<h1 id="heading">${title}</h1>
<main id="content"><p>Cost audit fixture page. No scripts, no styles, no widgets.</p></main>
${media ? `<audio id="probe-media" autoplay loop preload="auto" src="${mediaUri}"></audio>
<div id="ytmusic-player"><div id="player"></div></div>` : ""}
</body>
</html>`;
}

/**
 * Start both fixture servers.
 * @returns {Promise<{httpUrl: string, httpsUrl: string|null, httpPort: number, httpsPort: number|null, mediaUri: string, close: () => Promise<void>}>}
 */
export async function startFixtureServers({ certDir } = {}) {
  const mediaUri = sineWavDataUri();
  const handler = (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    const wantsMedia = url.pathname.startsWith("/media") || url.pathname.startsWith("/watch");
    const title = `${req.headers.host ?? "local"}${url.pathname}`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    res.end(page({ title, media: wantsMedia, mediaUri }));
  };

  const http = createHttpServer(handler);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const httpPort = http.address().port;

  let https = null;
  let httpsPort = null;
  let cert = null;
  const problems = [];
  if (certDir) {
    cert = mintCertificate(certDir);
    if (!cert) {
      problems.push("no openssl available, so no https origin for the host-pinned extensions");
    } else {
      https = createHttpsServer({ key: cert.key, cert: cert.cert }, handler);
      await new Promise((resolve) => https.listen(0, "127.0.0.1", resolve));
      httpsPort = https.address().port;
    }
  }

  return {
    httpUrl: `http://127.0.0.1:${httpPort}`,
    httpsUrl: httpsPort ? `https://${cert.host}` : null,
    httpPort,
    httpsPort,
    mediaUri,
    problems,
    async close() {
      await new Promise((resolve) => http.close(resolve));
      if (https) await new Promise((resolve) => https.close(resolve));
    },
  };
}
