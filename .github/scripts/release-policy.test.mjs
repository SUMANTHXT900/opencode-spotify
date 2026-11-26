import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
