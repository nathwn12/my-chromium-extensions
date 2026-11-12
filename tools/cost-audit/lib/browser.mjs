// Find, launch and cleanly kill a Chromium browser for the audit.
//
// The owner's profile is never touched: every run gets a throwaway
// --user-data-dir under the scratch directory, removed on exit.
//
// Loading route: Chrome 157 ignores --load-extension silently (probed:
// no extension appears in Target.getTargets, and --disable-features=
// DisableLoadExtensionCommandLineSwitch does not restore it). The CDP
// `Extensions` domain does load unpacked extensions and reports their ids, so
// that is the route used here.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

const SCRATCH = "C:\\Users\\nathan\\AppData\\Local\\Temp\\opencode\\cx";

/** Probed in order, exactly as the brief orders them. */
export const BROWSER_CANDIDATES = [
  { name: "Brave", path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
  { name: "Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
];

export function findBrowser({ exists = existsSync } = {}) {
  for (const candidate of BROWSER_CANDIDATES) {
    if (exists(candidate.path)) return candidate;
  }
  return null;
}

/** `DevToolsActivePort` holds the port on the first line, the socket path on the second. */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const port = Number(lines[0]);
  const path = lines[1].trim();
  if (!Number.isInteger(port) || port <= 0 || !path.startsWith("/")) return null;
  return { port, path };
}

export function wsUrlFor({ port, path }) {
  return `ws://127.0.0.1:${port}${path}`;
}

export function buildArgs({ profileDir, extraArgs = [], hostMapperRules = [], headless = true }) {
  const rules = hostMapperRules
    .map(({ host, ip, port }) => `MAP ${host} ${ip}${port ? `:${port}` : ""}`)
    .join(",");
  return [
    // --mute-audio is not optional. Every launch path, headless or headed, is
    // silent: this harness ran audibly once and that must never recur.
    ...(headless ? ["--headless=new"] : []),
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-domain-reliability",
    "--no-pings",
    ...(rules ? [`--host-resolver-rules=${rules}`] : []),
    ...extraArgs,
    "about:blank",
  ];
}

/**
 * Launch headless and connect to the browser endpoint.
 * @returns {Promise<{client: object, port: number, child: import("node:child_process").ChildProcess, profileDir: string}>}
 */
export async function launch({ browser, profileDir, extraArgs = [], hostMapperRules = [], headless = true, timeoutMs = 30000 }) {
  const args = buildArgs({ profileDir, extraArgs, hostMapperRules, headless });
  assertSilent(args, headless);
  const child = spawn(browser.path, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let endpoint = null;
  while (Date.now() < deadline) {
    if (exited) break;
    if (existsSync(portFile)) {
      endpoint = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
      if (endpoint) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) {
    child.kill();
    throw new Error(
      `browser never published DevToolsActivePort under ${profileDir}${exited ? " (it exited)" : ""}: ${stderr.replace(/\s+/g, " ").slice(-400) || "(no output)"}`,
    );
  }

  const client = await connect(wsUrlFor(endpoint), { timeoutMs });
  return { client, port: endpoint.port, child, profileDir, stderr: () => stderr };
}

export function makeProfileDir(prefix = "profile") {
  return mkdtempSync(join(SCRATCH, `${prefix}-`));
}

/** Flags that make a launch silent. Audit and refusal both read this list. */
export const REQUIRED_SILENT_FLAGS = ["--mute-audio", "--autoplay-policy=no-user-gesture-required"];

/**
 * The audio contract, as code: throws when an argv could be audible, and is the
 * body of the `--silent-check` self-test.
 * @returns {string[]} the problems found, empty when the argv is safe
 */
export function silentArgvProblems(argv, { headless = true, scratchRoot = SCRATCH } = {}) {
  const problems = [];
  for (const flag of REQUIRED_SILENT_FLAGS) {
    if (!argv.includes(flag)) problems.push(`missing ${flag}`);
  }
  if (headless && !argv.includes("--headless=new")) problems.push("missing --headless=new");
  if (!headless && argv.includes("--headless=new")) problems.push("headed argv still carries --headless=new");
  const profileArgs = argv.filter((arg) => arg.startsWith("--user-data-dir="));
  if (profileArgs.length !== 1) problems.push(`expected exactly one --user-data-dir, found ${profileArgs.length}`);
  for (const arg of profileArgs) {
    const dir = arg.slice("--user-data-dir=".length);
    if (!dir.toLowerCase().startsWith(scratchRoot.toLowerCase())) {
      problems.push(`--user-data-dir is outside the throwaway scratch root: ${dir}`);
    }
  }
  if (argv.some((arg) => arg.startsWith("--remote-allow-origins"))) problems.push("--remote-allow-origins widens the debug endpoint");
  return problems;
}

function assertSilent(argv, headless) {
  const problems = silentArgvProblems(argv, { headless });
  if (problems.length) {
    throw new Error(`refusing to launch an audible or unsafe browser: ${problems.join("; ")}`);
  }
}

/** Every argv this harness can produce, checked. Returns problems, empty when safe. */
export function silentCheck() {
  const problems = [];
  for (const headless of [true, false]) {
    const argv = buildArgs({
      profileDir: join(SCRATCH, `profile-silent-check-${headless ? "headless" : "headed"}`),
      headless,
      hostMapperRules: [{ host: "music.youtube.com", ip: "127.0.0.1", port: 8443 }],
      extraArgs: headless ? ["--ignore-certificate-errors"] : [],
    });
    for (const problem of silentArgvProblems(argv, { headless })) {
      problems.push(`${headless ? "headless" : "headed"}: ${problem}`);
    }
  }
  return problems;
}

function runPowerShell(script) {
  for (const shell of ["pwsh", "powershell"]) {
    try {
      return execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      if (shell === "powershell") return `__error__ ${error?.message ?? error}`;
    }
  }
  return "";
}

/** PIDs of browsers whose command line carries this exact throwaway profile. */
export function strayPids(profileDir) {
  const literal = String(profileDir).replace(/'/g, "''");
  const output = runPowerShell(
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='brave.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | Select-Object -ExpandProperty ProcessId`,
  );
  if (!output || output.startsWith("__error__")) return [];
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Kill only browsers started with this throwaway profile. Never the owner's. */
export function killStrays(profileDir) {
  const before = strayPids(profileDir);
  if (!before.length) return { killed: [], remaining: [] };
  const literal = String(profileDir).replace(/'/g, "''");
  runPowerShell(
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='brave.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
  return { killed: before, remaining: strayPids(profileDir) };
}

/** Kill the browser and remove the throwaway profile. Never throws. */
export async function stop({ client, child, profileDir }) {
  const problems = [];
  try {
    client?.close();
  } catch {
    /* already closed */
  }
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40 && child && child.exitCode === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The child may have left helpers behind: kill by profile path, then confirm.
  const strays = killStrays(profileDir);
  if (strays.killed.length) problems.push(`killed stray browser processes by profile path: ${strays.killed.join(", ")}`);
  if (strays.remaining.length) problems.push(`browser processes still alive for ${profileDir}: ${strays.remaining.join(", ")}`);

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
      return problems;
    } catch (error) {
      problems.push(`attempt ${attempt + 1}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return problems.concat(`leftover profile at ${profileDir} — remove it by hand`);
}

/** `Extensions.loadUnpacked` for each package; returns [{package, id, name, version}]. */
export async function loadUnpacked(client, packages) {
  const loaded = [];
  for (const pkg of packages) {
    const { id } = await client.send("Extensions.loadUnpacked", { path: pkg.dir });
    loaded.push({ package: pkg.name, dir: pkg.dir, id });
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  const { extensions } = await client.send("Extensions.getExtensions");
  const byId = new Map(extensions.map((e) => [e.id, e]));
  return loaded.map((entry) => ({
    ...entry,
    name: byId.get(entry.id)?.name ?? entry.package,
    version: byId.get(entry.id)?.version ?? "unknown",
    enabled: byId.get(entry.id)?.enabled ?? false,
  }));
}

/** Every extension the profile has loaded, ours and Chrome's own components. */
export async function listExtensions(client) {
  const { extensions } = await client.send("Extensions.getExtensions");
  return extensions;
}

export function browserVersion(client) {
  return client.send("Browser.getVersion").then((v) => v.product);
}
