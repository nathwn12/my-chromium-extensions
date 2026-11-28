// Pure release logic: no filesystem, no git. Callers pass file text in and
// get a plan (writes + commit message + commands) back.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const BUMP_PARTS = { major: 0, minor: 1, patch: 2 };

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

function problem(message) {
  throw new ReleaseError(message);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseSemver(text, what) {
  const match = SEMVER_RE.exec(String(text ?? "").trim());
  if (!match) problem(`${what} is not x.y.z (got ${JSON.stringify(text)})`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function validatePackageName(pkg) {
  if (!pkg || pkg.includes("/") || pkg.includes("\\") || pkg === "." || pkg === "..") {
    problem(`invalid package name ${JSON.stringify(pkg)}`);
  }
  return pkg;
}

export function parseBump(token, packageCount) {
  if (Object.hasOwn(BUMP_PARTS, token)) return { kind: "increment", part: BUMP_PARTS[token] };
  const version = parseSemver(token, "requested version");
  if (packageCount !== 1) {
    problem(`explicit version ${token} requires exactly one package (got ${packageCount})`);
  }
  return { kind: "explicit", version };
}

export function bumpVersion(current, bump) {
  if (bump.kind === "explicit") return bump.version;
  const next = [...current];
  next[bump.part] += 1;
  for (let i = bump.part + 1; i < 3; i += 1) next[i] = 0;
  return next;
}

export function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function formatJson(raw, value) {
  return JSON.stringify(value, null, 2).split("\n").join(eolOf(raw)) + eolOf(raw);
}

export function promoteChangelog(raw, version, date) {
  const heading = /^## \[Unreleased\][ \t]*$/m;
  if (!heading.test(raw)) problem("CHANGELOG.md has no ## [Unreleased] section to promote");
  return raw.replace(heading, `## [Unreleased]${eolOf(raw)}${eolOf(raw)}## [${version}] - ${date}`);
}

export function latestReleasedVersion(raw) {
  const match = /^## \[(\d+\.\d+\.\d+)\][^\r\n]*$/m.exec(raw);
  return match ? match[1] : null;
}

// Split/rejoin on LF is byte-preserving: any CR before an LF stays in its line.
function locateLockVersion(raw, pkg) {
  const lines = raw.split("\n");
  const nameRe = new RegExp(`^[ \t]*"packages/${escapeRegExp(pkg)}"[ \t]*:[ \t]*\\{`);
  const start = lines.findIndex((line) => nameRe.test(line));
  if (start < 0) problem(`bun.lock has no workspace entry for packages/${pkg}`);
  const indent = /^[ \t]*/.exec(lines[start])[0].length;
  const lineVersion = /^([ \t]*"version":[ \t]*")([^"]+)(")/;
  const inlineVersion = /("version":[ \t]*")([^"]+)(")/;

  const onOpeningLine = lineVersion.exec(lines[start]);
  if (onOpeningLine) return { lines, index: start, match: onOpeningLine };
  const inline = inlineVersion.exec(lines[start]);
  if (inline) return { lines, index: start, inline };

  const closeRe = new RegExp(`^[ \t]{0,${indent}}\\}[ \t]*,?\\r?$`);
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lineVersion.exec(lines[i]);
    if (match) return { lines, index: i, match };
    if (closeRe.test(lines[i])) break;
  }
  problem(`bun.lock workspace packages/${pkg} has no version field`);
}

export function readLockVersion(raw, pkg) {
  const located = locateLockVersion(raw, pkg);
  return located.match ? located.match[2] : located.inline[2];
}

export function rewriteLockVersion(raw, pkg, version) {
  const located = locateLockVersion(raw, pkg);
  if (located.match) {
    const line = located.lines[located.index];
    const match = located.match;
    located.lines[located.index] =
      line.slice(0, match.index) + match[1] + version + match[3] +
      line.slice(match.index + match[0].length);
  } else {
    located.lines[located.index] = located.lines[located.index].replace(
      located.inline[0],
      located.inline[1] + version + located.inline[3]
    );
  }
  return located.lines.join("\n");
}

export function validatePlan(plan) {
  const issues = [];
  if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) {
    return ["plan names no packages"];
  }
  const pkgs = plan.packages.map((entry) => entry.pkg);
  const paths = Array.isArray(plan.writes) ? plan.writes.map((write) => write.path) : [];
  if (paths.length === 0) issues.push("plan has no writes");
  else {
    if (new Set(paths).size !== paths.length) issues.push("plan writes a path twice");
    if (!paths.includes("bun.lock")) issues.push("plan does not write bun.lock");
    for (const pkg of pkgs) {
      if (!paths.includes(`packages/${pkg}/manifest.json`)) {
        issues.push(`plan does not write packages/${pkg}/manifest.json`);
      }
      if (!paths.includes(`packages/${pkg}/CHANGELOG.md`)) {
        issues.push(`plan does not write packages/${pkg}/CHANGELOG.md`);
      }
    }
  }
  if (!Array.isArray(plan.tags) || plan.tags.join(" ") !== pkgs.join(" ")) {
    issues.push(`tags must be exactly the package names: ${pkgs.join(", ")}`);
  }
  const commandText = [
    plan.commands?.add,
    plan.commands?.commit,
    ...(plan.commands?.tag ?? []),
    ...(plan.commands?.push ?? []),
  ].filter(Boolean).join("\n");
  if (/git tag v\d/.test(commandText)) issues.push("a v-prefixed version tag would be created");
  return issues;
}

export function buildPlan({ pkgs, bump, date, files }) {
  const setupIssues = [];
  if (!Array.isArray(pkgs) || pkgs.length === 0) problem("no packages named");
  const seen = new Set();
  for (const pkg of pkgs) {
    try { validatePackageName(pkg); } catch (error) { setupIssues.push(error.message); continue; }
    if (seen.has(pkg)) setupIssues.push(`${pkg}: named more than once`);
    seen.add(pkg);
  }
  let parsedBump;
  try { parsedBump = parseBump(bump, pkgs.length); } catch (error) { setupIssues.push(error.message); }
  if (setupIssues.length) problem(setupIssues.join("\n"));

  const issues = [];
  const entries = [];
  for (const pkg of pkgs) {
    const prefix = `packages/${pkg}`;
    const manifestRaw = files[`${prefix}/manifest.json`];
    if (typeof manifestRaw !== "string") {
      issues.push(`${prefix}/manifest.json is missing for ${pkg}`);
      continue;
    }
    let manifest;
    try { manifest = JSON.parse(manifestRaw); }
    catch (error) { issues.push(`${prefix}/manifest.json is not JSON for ${pkg}: ${error.message}`); continue; }
    let current;
    try { current = parseSemver(manifest.version, `${prefix}/manifest.json version for ${pkg}`); }
    catch (error) { issues.push(error.message); continue; }
    const currentText = current.join(".");

    let packageJson = null;
    let packageRaw = null;
    let packageHasVersion = false;
    if (Object.hasOwn(files, `${prefix}/package.json`)) {
      packageRaw = files[`${prefix}/package.json`];
      try { packageJson = JSON.parse(packageRaw); }
      catch (error) { issues.push(`${prefix}/package.json is not JSON for ${pkg}: ${error.message}`); }
      if (packageJson && typeof packageJson.version === "string") {
        packageHasVersion = true;
        if (packageJson.version !== currentText) {
          issues.push(`${prefix}/package.json is ${packageJson.version} while ${pkg} manifest is ${currentText}`);
        }
      }
    }

    const changelogRaw = files[`${prefix}/CHANGELOG.md`];
    if (typeof changelogRaw !== "string") {
      issues.push(`${prefix}/CHANGELOG.md is missing for ${pkg}`);
    } else {
      if (!/^## \[Unreleased\][ \t]*$/m.test(changelogRaw)) {
        issues.push(`${prefix}/CHANGELOG.md for ${pkg} has no ## [Unreleased] section`);
      }
      const latest = latestReleasedVersion(changelogRaw);
      if (latest !== currentText) {
        issues.push(`${prefix}/CHANGELOG.md latest is ${latest ?? "missing"} while ${pkg} manifest is ${currentText}`);
      }
    }

    let lockVersion;
    try { lockVersion = readLockVersion(files["bun.lock"] ?? "", pkg); }
    catch (error) { issues.push(`for ${pkg}: ${error.message}`); }
    if (lockVersion !== undefined && lockVersion !== currentText) {
      issues.push(`bun.lock workspace ${prefix} is ${lockVersion} while ${pkg} manifest is ${currentText}`);
    }

    const next = bumpVersion(current, parsedBump);
    const nextText = next.join(".");
    if (compare(next, current) <= 0) {
      issues.push(`${pkg}: new version ${nextText} is not greater than ${currentText}`);
    }
    entries.push({
      pkg, prefix, manifestRaw, manifest, currentText, packageRaw, packageJson,
      packageHasVersion, changelogRaw, nextText,
    });
  }
  if (issues.length) problem(issues.join("\n"));

  const writes = [];
  for (const entry of entries) {
    writes.push({
      path: `${entry.prefix}/manifest.json`,
      content: formatJson(entry.manifestRaw, { ...entry.manifest, version: entry.nextText }),
      note: `${entry.currentText} -> ${entry.nextText}`,
    });
    if (entry.packageHasVersion) {
      writes.push({
        path: `${entry.prefix}/package.json`,
        content: formatJson(entry.packageRaw, { ...entry.packageJson, version: entry.nextText }),
        note: `${entry.currentText} -> ${entry.nextText}`,
      });
    }
    writes.push({
      path: `${entry.prefix}/CHANGELOG.md`,
      content: promoteChangelog(entry.changelogRaw, entry.nextText, date),
      note: `promoted ## [Unreleased] to ## [${entry.nextText}] - ${date}`,
    });
  }
  let lockRaw = files["bun.lock"];
  for (const entry of entries) lockRaw = rewriteLockVersion(lockRaw, entry.pkg, entry.nextText);
  writes.push({
    path: "bun.lock",
    content: lockRaw,
    note: `workspaces: ${entries.map((entry) => `${entry.pkg} ${entry.nextText}`).join(", ")}`,
  });

  const summary = entries.map((entry) => `${entry.pkg} ${entry.nextText}`).join(", ");
  const commitMessage = entries.length === 1
    ? `release(${entries[0].pkg}): ${entries[0].nextText}`
    : `release: ${summary}`;
  const plan = {
    packages: entries.map((entry) => ({
      pkg: entry.pkg, current: entry.currentText, next: entry.nextText,
    })),
    writes,
    commitMessage,
    tags: [...pkgs],
    commands: {
      add: `git add ${writes.map((write) => write.path).join(" ")}`,
      commit: `git commit -m "${commitMessage}"`,
      tag: pkgs.map((pkg) => `git tag -f ${pkg}`),
      push: [`git push origin HEAD`, `git push --force origin ${pkgs.join(" ")}`],
    },
    bump: parsedBump,
    date,
  };
  const problems = validatePlan(plan);
  if (problems.length) problem(problems.join("\n"));
  return plan;
}
