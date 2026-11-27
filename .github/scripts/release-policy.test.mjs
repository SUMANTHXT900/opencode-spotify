import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./validate-release-policy.mjs", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../plugin/package.json", import.meta.url), "utf8"));
const version = manifest.version;
const channel = version.includes("-") ? "beta" : "latest";
const source = "a".repeat(40);
const repo = "owner/opencode-spotify";

function run(mode, env) {
  const result = spawnSync(process.execPath, [helper, mode], {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 10_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

test("prepare requires the exact manifest version and a branch, not a tag", () => {
  const env = {
    INPUT_VERSION: version, INPUT_DIST_TAG: channel, INPUT_CONFIRM: "PREPARE",
    REF_TYPE: "branch", REF_NAME: "main",
  };
  assert.equal(run("prepare", env).status, 0);
  for (const override of [{ REF_TYPE: "tag" }, { INPUT_CONFIRM: "PUBLISH" },
    { INPUT_VERSION: "0.01.0-beta.1" }, { INPUT_VERSION: "0.1.0-beta..1" },
    { INPUT_VERSION: `${version}\n` }, { INPUT_VERSION: "99.99.99" }]) {
    assert.equal(run("prepare", { ...env, ...override }).status, 1, JSON.stringify(override));
  }
});

test("candidate recheck binds run, repository, source and both independently computed digests", () => {
  const dir = mkdtempSync(join(tmpdir(), "spotify-release-proof-"));
  try {
    const bytes = Buffer.from("isolated proof fixture");
    const name = `opencode-spotify-${version}.tgz`;
    const path = join(dir, name);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    writeFileSync(path, bytes);
    writeFileSync(`${path}.sha256`, `${sha256}  ${name}\n`);
    writeFileSync(`${path}.integrity`, `${sha512}\n`);
    assert.equal(run("write-proof", {
      CANDIDATE_DIR: dir, SOURCE_SHA: source, RUN_ID: "101",
      REPOSITORY: repo, WORKFLOW_NAME: "Release to npm (manual)",
    }).status, 0);
    const env = {
      CANDIDATE_DIR: dir, SOURCE_SHA: source, PREPARE_RUN_ID: "101",
      EXPECTED_REPOSITORY: repo, INPUT_VERSION: version,
      EXPECTED_SHA256: sha256, EXPECTED_SHA512: sha512,
    };
    assert.equal(run("recheck", env).status, 0);
    for (const override of [{ PREPARE_RUN_ID: "102" },
      { SOURCE_SHA: "b".repeat(40) }, { EXPECTED_REPOSITORY: "other/opencode-spotify" },
      { EXPECTED_SHA256: "f".repeat(64) }, { EXPECTED_SHA512: `sha512-${"A".repeat(86)}==` }]) {
      assert.equal(run("recheck", { ...env, ...override }).status, 1, JSON.stringify(override));
    }
    writeFileSync(path, "different bytes");
    assert.equal(run("recheck", env).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dist-tag guard prevents equal or backwards releases with numeric prerelease ordering", () => {
  const env = { INPUT_VERSION: "0.6.0-beta.10", INPUT_DIST_TAG: "beta" };
  assert.equal(run("tag-preflight", { ...env, CURRENT_TAG: "0.6.0-beta.9" }).status, 0);
  assert.equal(run("tag-preflight", { ...env, CURRENT_TAG: env.INPUT_VERSION }).status, 1);
  assert.equal(run("tag-preflight", { ...env, CURRENT_TAG: "0.6.0-beta.11" }).status, 1);
  assert.equal(run("tag-preflight", { ...env, CURRENT_TAG: "" }).status, 0);
});

test("latest publishes only from main (release/* is beta-only)", () => {
  const prepareEnv = {
    INPUT_VERSION: "0.6.0", INPUT_DIST_TAG: "latest", INPUT_CONFIRM: "PREPARE",
    REF_TYPE: "branch", REF_NAME: "release/v0.6.0",
  };
  assert.equal(run("prepare", prepareEnv).status, 1);
  const publishEnv = {
    INPUT_VERSION: "0.6.0", INPUT_DIST_TAG: "latest", INPUT_CONFIRM: "PUBLISH",
    EXPECTED_SHA256: "a".repeat(64), EXPECTED_SHA512: `sha512-${"A".repeat(86)}==`,
    PREPARE_RUN_ID: "101", CURRENT_RUN_ID: "102",
    SOURCE_SHA: source, SOURCE_BRANCH: "release/v0.6.0", NPM_PUBLISH_ENABLED: "true",
  };
  assert.equal(run("publish", publishEnv).status, 1);
  assert.equal(run("publish", { ...publishEnv, SOURCE_BRANCH: "main" }).status, 0);
  assert.equal(run("publish", { ...publishEnv, SOURCE_BRANCH: "main", INPUT_CONFIRM: "PREPARE" }).status, 1);
  assert.equal(run("publish", { ...publishEnv, SOURCE_BRANCH: "main", NPM_PUBLISH_ENABLED: "false" }).status, 1);
});

// Run the tag-release helper against an isolated repo copy so hardcoded
// versions (v0.6.0, v0.6.0-beta.4) can be exercised without touching the
// real plugin/package.json. The helper resolves the manifest relative to
// its own location, so a copy under a temp root reads the temp manifest.
function runIsolatedTagRelease({ manifestVersion, tagName, refType = "tag" }) {
  const root = mkdtempSync(join(tmpdir(), "spotify-release-tag-"));
  try {
    mkdirSync(join(root, ".github", "scripts"), { recursive: true });
    mkdirSync(join(root, "plugin"), { recursive: true });
    copyFileSync(helper, join(root, ".github", "scripts", "validate-release-policy.mjs"));
    writeFileSync(join(root, "plugin", "package.json"), JSON.stringify({ version: manifestVersion }));
    const target = join(root, ".github", "scripts", "validate-release-policy.mjs");
    const result = spawnSync(process.execPath, [target, "tag-release"], {
      encoding: "utf8",
      env: { ...process.env, REF_TYPE: refType, TAG_NAME: tagName },
      timeout: 10_000, windowsHide: true,
    });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("tag-release maps v0.6.0 to latest and v0.6.0-beta.4 to beta", () => {
  const stable = runIsolatedTagRelease({ manifestVersion: "0.6.0", tagName: "v0.6.0" });
  assert.equal(stable.status, 0, stable.stderr);
  assert.match(stable.stdout, /^version=0\.6\.0$/m);
  assert.match(stable.stdout, /^dist_tag=latest$/m);
  const beta = runIsolatedTagRelease({ manifestVersion: "0.6.0-beta.4", tagName: "v0.6.0-beta.4" });
  assert.equal(beta.status, 0, beta.stderr);
  assert.match(beta.stdout, /^version=0\.6\.0-beta\.4$/m);
  assert.match(beta.stdout, /^dist_tag=beta$/m);
});

test("tag-release accepts the current manifest tag and writes GITHUB_OUTPUT", () => {
  const tag = `v${version}`;
  const direct = run("tag-release", { REF_TYPE: "tag", TAG_NAME: tag });
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, new RegExp(`^version=${version.replace(/\./g, "\\.")}$`, "m"));
  assert.match(direct.stdout, new RegExp(`^dist_tag=${channel}$`, "m"));
  const dir = mkdtempSync(join(tmpdir(), "spotify-release-output-"));
  try {
    const outFile = join(dir, "github_output");
    writeFileSync(outFile, "");
    const withOutput = run("tag-release", {
      REF_TYPE: "tag", TAG_NAME: tag, GITHUB_OUTPUT: outFile,
    });
    assert.equal(withOutput.status, 0, withOutput.stderr);
    const body = readFileSync(outFile, "utf8");
    assert.match(body, new RegExp(`^version=${version.replace(/\./g, "\\.")}$`, "m"));
    assert.match(body, new RegExp(`^dist_tag=${channel}$`, "m"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tag-release rejects mismatched tags, non-tag refs and malformed versions", () => {
  // Tag/manifest mismatch rejected (well-formed tag, wrong version).
  assert.equal(run("tag-release", { REF_TYPE: "tag", TAG_NAME: "v0.6.1" }).status, 1);
  assert.equal(run("tag-release", { REF_TYPE: "tag", TAG_NAME: "v9.9.9-beta.1" }).status, 1);
  assert.equal(
    runIsolatedTagRelease({ manifestVersion: "0.6.0", tagName: "v0.6.1" }).status, 1,
  );
  // Non-tag ref rejected even when the tag itself matches the manifest.
  assert.equal(run("tag-release", { REF_TYPE: "branch", TAG_NAME: `v${version}` }).status, 1);
  assert.equal(
    runIsolatedTagRelease({ manifestVersion: "0.6.0", tagName: "v0.6.0", refType: "branch" }).status,
    1,
  );
  // Malformed semver rejected: missing v, incomplete core, leading zeros,
  // unexpected prerelease tags, missing prerelease number, build metadata,
  // empty identifiers. None of these reach the manifest comparison.
  for (const bad of [
    "0.6.0",
    "v0.6",
    "v01.6.0-beta.1",
    "v0.6.0-beta",
    "v0.6.0-alpha.1",
    "v0.6.0-rc.1",
    "v0.6.0-beta.01",
    "v0.6.0-beta.4+build",
    "v0.6.0-beta..4",
    "v0.6.0-",
  ]) {
    assert.equal(run("tag-release", { REF_TYPE: "tag", TAG_NAME: bad }).status, 1, bad);
  }
});

test("recheck and tag-preflight stay green when the candidate run is the current run", () => {
  // The tag flow verifies the candidate from this same run, so
  // PREPARE_RUN_ID equals the current run id by design. Neither recheck
  // nor tag-preflight couples to CURRENT_RUN_ID.
  const dir = mkdtempSync(join(tmpdir(), "spotify-release-samerun-"));
  try {
    const bytes = Buffer.from("same-run candidate fixture");
    const name = `opencode-spotify-${version}.tgz`;
    const path = join(dir, name);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    writeFileSync(path, bytes);
    writeFileSync(`${path}.sha256`, `${sha256}  ${name}\n`);
    writeFileSync(`${path}.integrity`, `${sha512}\n`);
    assert.equal(run("write-proof", {
      CANDIDATE_DIR: dir, SOURCE_SHA: source, RUN_ID: "202",
      REPOSITORY: repo, WORKFLOW_NAME: "Release to npm",
    }).status, 0);
    const env = {
      CANDIDATE_DIR: dir, SOURCE_SHA: source, PREPARE_RUN_ID: "202",
      CURRENT_RUN_ID: "202", EXPECTED_REPOSITORY: repo, INPUT_VERSION: version,
      EXPECTED_SHA256: sha256, EXPECTED_SHA512: sha512,
    };
    assert.equal(run("recheck", env).status, 0);
    assert.equal(run("tag-preflight", {
      INPUT_VERSION: version, INPUT_DIST_TAG: channel, CURRENT_TAG: "",
      CURRENT_RUN_ID: "202",
    }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tag-preflight orders stable releases above their prereleases", () => {
  assert.equal(run("tag-preflight", {
    INPUT_VERSION: "0.6.0", INPUT_DIST_TAG: "latest", CURRENT_TAG: "0.6.0-beta.4",
  }).status, 0);
  assert.equal(run("tag-preflight", {
    INPUT_VERSION: "0.6.0-beta.4", INPUT_DIST_TAG: "beta", CURRENT_TAG: "0.6.0",
  }).status, 1);
});
