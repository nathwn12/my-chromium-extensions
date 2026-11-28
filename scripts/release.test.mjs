import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const tempRoots = [];
const today = new Date().toISOString().slice(0, 10);

after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function git(args, cwd) {
  return spawnSync(
    "git",
    ["-c", "user.name=Release Test", "-c", "user.email=release@example.com", ...args],
    { cwd, encoding: "utf8", windowsHide: true },
  );
}

// Each case runs the real CLI from a copied script tree inside a throwaway git
// repo, so dirty-tree and commit/tag/push checks are real git state, not mocks.
function fixture({ versions = { alpha: "1.2.3", beta: "2.4.5" }, overrides = {}, eol = "\n", remote = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "release-test-"));
  tempRoots.push(base);
  const dir = join(base, "repo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(SCRIPTS, "release.mjs"), join(dir, "scripts", "release.mjs"));
  const libSource = join(SCRIPTS, "release-lib.mjs");
  if (existsSync(libSource)) copyFileSync(libSource, join(dir, "scripts", "release-lib.mjs"));

  for (const [pkg, version] of Object.entries(versions)) {
    const pkgDir = join(dir, "packages", pkg);
    mkdirSync(pkgDir, { recursive: true });
    const manifest = { manifest_version: 3, name: pkg, version };
    writeFileSync(join(pkgDir, "manifest.json"), JSON.stringify(manifest, null, 2).split("\n").join(eol) + eol);
    const packageJson = { name: pkg, private: true, version, scripts: { test: "echo ok" } };
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(packageJson, null, 2).split("\n").join(eol) + eol);
    const changelog = [
      "# Changelog", "", "## [Unreleased]", "",
      "## [" + version + "] - 2026-01-01", "", "- initial", "",
    ];
    writeFileSync(join(pkgDir, "CHANGELOG.md"), changelog.join(eol));
  }

  const lock = [
    "{",
    "  \"lockfileVersion\": 2,",
    "  \"workspaces\": {",
    "    \"\": {},",
    ...Object.entries(versions).flatMap(([pkg, version]) => [
      "    \"packages/" + pkg + "\": {",
      "      \"name\": \"" + pkg + "\",",
      "      \"version\": \"" + version + "\",",
      "    },",
    ]),
    "    \"other\": \"keep\",",
    "  },",
    "  \"packages\": {},",
    "}",
    "",
  ].join(eol);
  writeFileSync(join(dir, "bun.lock"), lock);
  for (const [rel, content] of Object.entries(overrides)) writeFileSync(join(dir, rel), content);

  assert.equal(git(["init", "-q"], dir).status, 0);
  assert.equal(git(["add", "-A"], dir).status, 0);
  assert.equal(git(["commit", "-qm", "init"], dir).status, 0);
  let remoteDir = null;
  if (remote) {
    remoteDir = join(base, "remote.git");
    assert.equal(git(["init", "--bare", "-q", remoteDir], base).status, 0);
    assert.equal(git(["remote", "add", "origin", remoteDir], dir).status, 0);
  }
  return { base, dir, remoteDir };
}

function runCli(dir, args) {
  return spawnSync(process.execPath, [join(dir, "scripts", "release.mjs"), ...args], {
    cwd: dir, encoding: "utf8", windowsHide: true,
  });
}

function read(dir, rel) {
  return readFileSync(join(dir, rel), "utf8");
}

function snapshot(dir) {
  const files = ["bun.lock"];
  for (const pkg of ["alpha", "beta"]) {
    for (const name of ["manifest.json", "package.json", "CHANGELOG.md"]) files.push("packages/" + pkg + "/" + name);
  }
  return Object.fromEntries(files.map((rel) => [rel, read(dir, rel)]));
}

test("CLI: one multi-package patch bump writes both packages and the lock", () => {
  const { dir } = fixture();
  const result = runCli(dir, ["alpha", "beta", "patch"]);
  assert.equal(result.status, 0, result.stderr);
  for (const [pkg, next, prev] of [["alpha", "1.2.4", "1.2.3"], ["beta", "2.4.6", "2.4.5"]]) {
    assert.equal(JSON.parse(read(dir, "packages/" + pkg + "/manifest.json")).version, next, pkg);
    assert.equal(JSON.parse(read(dir, "packages/" + pkg + "/package.json")).version, next, pkg);
    const log = read(dir, "packages/" + pkg + "/CHANGELOG.md");
    assert.match(log, /^## \[Unreleased\]\r?\n\r?\n## \[/m, pkg + " keeps an empty Unreleased");
    assert.match(log, new RegExp("^## \\[" + next + "\\] - " + today + "\\r?$", "m"), pkg + " promotes today's heading");
    assert.match(log, new RegExp("^## \\[" + next + "\\] - " + today + "\\r?\n\\r?\n## \\[" + prev.replaceAll(".", "\\.") + "\\]", "m"), pkg + " new release sits above the previous one");
  }
  const lock = read(dir, "bun.lock");
  assert.match(lock, /"packages\/alpha": \{\r?\n\s+"name": "alpha",\r?\n\s+"version": "1\.2\.4"/);
  assert.match(lock, /"packages\/beta": \{\r?\n\s+"name": "beta",\r?\n\s+"version": "2\.4\.6"/);
  assert.match(lock, /"other": "keep"/, "unrelated workspace is untouched");
  assert.match(result.stdout, /git tag -f alpha/);
  assert.match(result.stdout, /git tag -f beta/);
  assert.doesNotMatch(result.stdout, /git tag v\d/, "no version tag that the workflow ignores");
});

test("CLI: one disagreeing package blocks every package before any write", () => {
  const { dir } = fixture({
    overrides: {
      "packages/beta/package.json": JSON.stringify({ name: "beta", version: "9.9.9" }, null, 2) + "\n",
    },
  });
  const before = snapshot(dir);
  const result = runCli(dir, ["alpha", "beta", "patch"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /beta/, "the disagreeing package is named");
  assert.match(result.stderr, /package\.json/, "the disagreement is named");
  assert.deepEqual(snapshot(dir), before, "nothing was written");
});

test("CLI: an explicit version is rejected for two packages", () => {
  const { dir } = fixture();
  const before = snapshot(dir);
  const result = runCli(dir, ["alpha", "beta", "1.2.4"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one package/);
  assert.deepEqual(snapshot(dir), before);
});

test("CLI: a version in the package position explains that it must come last", () => {
  const { dir } = fixture();
  const before = snapshot(dir);
  const result = runCli(dir, ["audio-normalizer", "5.9.0", "presence-suite"]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.trim(),
    "release: an explicit version applies to exactly one package and must come last: release.mjs <package> <x.y.z> [flags]",
  );
  assert.deepEqual(snapshot(dir), before, "nothing was written");
});

test("CLI: dirty-path refusal fires only for a path about to be written", () => {
  const unrelated = fixture();
  writeFileSync(join(unrelated.dir, "README.md"), "unrelated work\n");
  const okUnrelated = runCli(unrelated.dir, ["alpha", "patch"]);
  assert.equal(okUnrelated.status, 0, okUnrelated.stderr);
  assert.equal(JSON.parse(read(unrelated.dir, "packages/alpha/manifest.json")).version, "1.2.4");

  const otherPackage = fixture();
  writeFileSync(join(otherPackage.dir, "packages/beta/CHANGELOG.md"), "uncommitted beta notes\n");
  const okOther = runCli(otherPackage.dir, ["alpha", "patch"]);
  assert.equal(okOther.status, 0, okOther.stderr);

  const written = fixture();
  const logPath = join(written.dir, "packages/alpha/CHANGELOG.md");
  writeFileSync(logPath, read(written.dir, "packages/alpha/CHANGELOG.md") + "dirty\n");
  const before = snapshot(written.dir);
  const refused = runCli(written.dir, ["alpha", "patch"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /packages\/alpha\/CHANGELOG\.md/);
  assert.deepEqual(snapshot(written.dir), before, "a refusal writes nothing");
});

test("CLI: --dry-run writes nothing and makes commit/tag/push no-ops", () => {
  const { dir } = fixture();
  const before = snapshot(dir);
  const result = runCli(dir, ["alpha", "beta", "patch", "--dry-run", "--commit", "--tag", "--push"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(dir), before, "no file changed");
  assert.match(result.stdout, /git add packages\/alpha\/manifest\.json/);
  assert.match(result.stdout, /git commit -m "release: alpha 1\.2\.4, beta 2\.4\.6"/);
  assert.match(result.stdout, /git tag -f alpha/);
  assert.match(result.stdout, /git tag -f beta/);
  assert.match(result.stdout, /git push origin HEAD/);
  assert.match(result.stdout, /git push --force origin alpha beta/);
  assert.doesNotMatch(result.stdout, /git tag v\d/);
  assert.match(git(["log", "-1", "--pretty=%s"], dir).stdout, /^init$/m, "no commit was made");
  assert.equal(git(["tag", "-l"], dir).stdout.trim(), "", "no tag was made");
});

test("CLI: --commit stages only the written files", () => {
  const { dir } = fixture();
  writeFileSync(join(dir, "README.md"), "unrelated work\n");
  const result = runCli(dir, ["alpha", "patch", "--commit"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(["log", "-1", "--pretty=%s"], dir).stdout.trim(), "release(alpha): 1.2.4");
  const staged = git(["show", "--pretty=format:", "--name-only", "HEAD"], dir).stdout.split("\n").filter(Boolean).sort();
  assert.deepEqual(staged, [
    "bun.lock",
    "packages/alpha/CHANGELOG.md",
    "packages/alpha/manifest.json",
    "packages/alpha/package.json",
  ]);
  assert.match(git(["status", "--porcelain"], dir).stdout, /README\.md/, "unrelated file stays unstaged");
});

test("CLI: --tag needs --commit and --push needs both", () => {
  for (const args of [["alpha", "patch", "--tag"], ["alpha", "patch", "--commit", "--push"], ["alpha", "patch", "--push"]]) {
    const { dir } = fixture();
    const before = snapshot(dir);
    const result = runCli(dir, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /requires --commit/);
    assert.deepEqual(snapshot(dir), before);
  }
});

test("CLI: --commit --tag --push pushes HEAD and the stable tags", () => {
  const { base, dir, remoteDir } = fixture({ remote: true });
  const result = runCli(dir, ["alpha", "beta", "patch", "--commit", "--tag", "--push"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git push origin HEAD/);
  assert.match(result.stdout, /git push --force origin alpha beta/);
  assert.equal(git(["log", "-1", "--pretty=%s"], dir).stdout.trim(), "release: alpha 1.2.4, beta 2.4.6");
  assert.deepEqual(git(["tag", "-l"], dir).stdout.trim().split("\n").sort(), ["alpha", "beta"]);
  assert.deepEqual(git(["--git-dir=" + remoteDir, "tag", "-l"], base).stdout.trim().split("\n").sort(), ["alpha", "beta"]);
});

test("CLI: CRLF files keep their line endings", () => {
  const { dir } = fixture({ eol: "\r\n" });
  const result = runCli(dir, ["alpha", "patch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(read(dir, "packages/alpha/CHANGELOG.md"), /## \[1\.2\.4\] - /);
  for (const rel of ["packages/alpha/manifest.json", "packages/alpha/package.json", "packages/alpha/CHANGELOG.md", "bun.lock"]) {
    const raw = read(dir, rel);
    assert.ok(raw.includes("\r\n"), rel + " stays CRLF");
    assert.equal(raw.replace(/\r\n/g, "").includes("\n"), false, rel + " has no bare LF");
  }
});

test("lib: bump parsing and comparison are pure and named", async () => {
  const lib = await import("./release-lib.mjs");
  assert.deepEqual(lib.parseBump("major", 2), { kind: "increment", part: 0 });
  assert.deepEqual(lib.parseBump("minor", 2), { kind: "increment", part: 1 });
  assert.deepEqual(lib.parseBump("patch", 2), { kind: "increment", part: 2 });
  assert.deepEqual(lib.parseBump("1.2.4", 1), { kind: "explicit", version: [1, 2, 4] });
  assert.throws(() => lib.parseBump("1.2.4", 2), /exactly one package/);
  assert.throws(() => lib.parseBump("1.2", 1), /x\.y\.z/);
  assert.equal(lib.compare([1, 2, 3], [1, 2, 4]), -1);
  assert.equal(lib.compare([2, 0, 0], [1, 9, 9]), 1);
  assert.equal(lib.compare([1, 2, 3], [1, 2, 3]), 0);
  assert.deepEqual(lib.bumpVersion([1, 2, 3], lib.parseBump("minor", 1)), [1, 3, 0]);
});

test("lib: changelog promotion keeps an empty Unreleased and CRLF", async () => {
  const lib = await import("./release-lib.mjs");
  const raw = "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [1.0.0] - 2026-01-01\r\n\r\n- old\r\n";
  assert.equal(
    lib.promoteChangelog(raw, "1.0.1", "2026-11-28"),
    "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [1.0.1] - 2026-11-28\r\n\r\n## [1.0.0] - 2026-01-01\r\n\r\n- old\r\n",
  );
  assert.equal(
    lib.promoteChangelog("## [Unreleased]\n\n- pending\n\n## [1.0.0] - 2026-01-01\n", "1.0.1", "2026-11-28"),
    "## [Unreleased]\n\n## [1.0.1] - 2026-11-28\n\n- pending\n\n## [1.0.0] - 2026-01-01\n",
  );
  assert.throws(() => lib.promoteChangelog("# no unreleased\n", "1.0.1", "2026-11-28"), /Unreleased/);
  assert.equal(lib.formatJson("{\r\n  \"version\": \"1.0.0\"\r\n}\r\n", { version: "1.0.1" }), "{\r\n  \"version\": \"1.0.1\"\r\n}\r\n");
});

test("lib: bun.lock workspace rewrite touches only the named entry", async () => {
  const lib = await import("./release-lib.mjs");
  const raw = [
    "{",
    "  \"workspaces\": {",
    "    \"alpha\": { \"version\": \"1.0.0\" },",
    "    \"packages/alpha\": {",
    "      \"name\": \"alpha\",",
    "      \"version\": \"1.0.0\",",
    "    },",
    "    \"packages/beta\": {",
    "      \"name\": \"beta\",",
    "      \"version\": \"2.0.0\",",
    "    },",
    "  },",
    "}",
    "",
  ].join("\n");
  const expected = raw.replace(
    "    \"packages/alpha\": {\n      \"name\": \"alpha\",\n      \"version\": \"1.0.0\",",
    "    \"packages/alpha\": {\n      \"name\": \"alpha\",\n      \"version\": \"1.0.1\",",
  );
  assert.equal(lib.rewriteLockVersion(raw, "alpha", "1.0.1"), expected);
  assert.equal(lib.readLockVersion(raw, "beta"), "2.0.0");
  assert.throws(() => lib.rewriteLockVersion(raw, "missing", "1.0.0"), /packages\/missing/);
});

test("lib: buildPlan and validatePlan agree on writes, tags and commit message", async () => {
  const lib = await import("./release-lib.mjs");
  const files = {
    "bun.lock": [
      "{", "  \"workspaces\": {",
      "    \"packages/alpha\": { \"name\": \"alpha\", \"version\": \"1.2.3\" },",
      "    \"packages/beta\": { \"name\": \"beta\", \"version\": \"2.4.5\" },",
      "  },", "}", "",
    ].join("\n"),
  };
  for (const [pkg, version] of [["alpha", "1.2.3"], ["beta", "2.4.5"]]) {
    files["packages/" + pkg + "/manifest.json"] = JSON.stringify({ name: pkg, version });
    files["packages/" + pkg + "/package.json"] = JSON.stringify({ name: pkg, version });
    files["packages/" + pkg + "/CHANGELOG.md"] = "## [Unreleased]\n\n## [" + version + "] - 2026-01-01\n";
  }
  const plan = lib.buildPlan({ pkgs: ["alpha", "beta"], bump: "patch", date: "2026-11-28", files });
  assert.deepEqual(lib.validatePlan(plan), []);
  assert.deepEqual(plan.tags, ["alpha", "beta"]);
  assert.equal(plan.commitMessage, "release: alpha 1.2.4, beta 2.4.6");
  assert.deepEqual(plan.writes.map((write) => write.path), [
    "packages/alpha/manifest.json",
    "packages/alpha/package.json",
    "packages/alpha/CHANGELOG.md",
    "packages/beta/manifest.json",
    "packages/beta/package.json",
    "packages/beta/CHANGELOG.md",
    "bun.lock",
  ]);
  assert.match(lib.validatePlan({ ...plan, tags: ["v1.2.4"] }).join(" "), /tag/);
  files["packages/beta/manifest.json"] = JSON.stringify({ name: "beta", version: "2.4.5" }).replace("2.4.5", "7.7.7");
  assert.throws(
    () => lib.buildPlan({ pkgs: ["alpha", "beta"], bump: "patch", date: "2026-11-28", files }),
    /beta/,
  );
});
