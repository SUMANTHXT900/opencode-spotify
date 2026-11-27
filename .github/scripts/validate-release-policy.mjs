#!/usr/bin/env node
/**
 * Release policy helper (WP-D).
 *
 * Non-packed: lives under .github/scripts, never shipped in the tarball.
 * Pure Node, no dependencies. All dynamic values arrive via environment
 * variables (workflows map every GitHub expression into env); this script
 * never sees a raw ${{ }} interpolation.
 *
 * Modes:
 *   prepare       - validate exact version + beta/latest branch policy.
 *                   Requires confirm == PREPARE, branch dispatch, strict
 *                   semver, and equality with plugin/package.json.
 *   publish       - validate version/channel/ref/branch types, canonical
 *                   digests, confirm == PUBLISH, numeric prepare run ID !=
 *                   current, and the NPM_PUBLISH_ENABLED kill switch.
 *   tag-release   - derive the release version and dist-tag from a pushed
 *                   git tag. Requires REF_TYPE == "tag" and TAG_NAME of the
 *                   form v<strict-semver> (leading v stripped). Only stable
 *                   (X.Y.Z) or -beta.N prereleases are accepted. The stripped
 *                   version must exactly equal plugin/package.json. The
 *                   dist-tag is derived deterministically (beta when the
 *                   version has a prerelease suffix, latest when stable) and
 *                   emitted as clean `version=<v>` / `dist_tag=<tag>` lines;
 *                   when GITHUB_OUTPUT is set both lines are appended to it
 *                   so a validate job can expose them as step outputs.
 *   write-proof   - verify the retained candidate dir and write proof.json.
 *   recheck       - verify a downloaded candidate against QA attestation
 *                   inputs, including proof run_id / repository / verifier.
 *   tag-preflight - strict-SemVer monotonicity for the selected dist-tag:
 *                   the release version must be strictly greater than the
 *                   tag's current target (prerelease precedence per
 *                   semver.org item 11). A missing tag (first use) allows.
 *
 * GitHub run identity (same-repo release.yml, workflow_dispatch, success) is
 * checked by the workflow with `gh api` (needs GH_TOKEN); this helper only
 * validates formats and policy so shells stay thin and quoted.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function sanitize(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function fail(message) {
  process.stderr.write(`release-policy: error: ${sanitize(message)}\n`);
  process.exit(1);
}

function need(name) {
  const value = process.env[name] ?? "";
  if (!value) fail(`missing required env ${name}`);
  if (/[\r\n]/.test(value)) fail(`env ${name} must be single-line (CR/LF rejected)`);
  return value;
}

function needOpt(name) {
  const value = process.env[name] ?? "";
  if (/[\r\n]/.test(value)) fail(`env ${name} must be single-line (CR/LF rejected)`);
  return value;
}

// Strict semver: no leading zeros in core or numeric prerelease identifiers,
// no empty prerelease identifiers, no build metadata ('+' rejected outright).
// Anchors are end-exact; need()/needOpt() additionally reject CR/LF, so a
// trailing newline can never slip through.
const SEMVER_STRICT =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-((0|[1-9]\d*|[0-9]*[a-zA-Z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|[0-9]*[a-zA-Z-][0-9A-Za-z-]*))*))?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const RUN_ID = /^[0-9]{1,19}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(main|release\/.+)$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERIFIER_ID = "scripts/verify-package.mjs";

function checkBranch(value, label) {
  if (value.length > 255 || /[\s~^:?*[\]\\]/.test(value) || !BRANCH.test(value)) {
    fail(`${label} must be 'main' or 'release/*' (got ${sanitize(value)})`);
  }
}

function checkChannel(version, channel) {
  if (channel !== "beta" && channel !== "latest") {
    fail(`dist-tag must be beta or latest (got ${sanitize(channel)})`);
  }
  const prerelease = version.includes("-");
  if (channel === "beta" && !prerelease) {
    fail("the beta tag requires a prerelease version such as 0.6.0-beta.4");
  }
  if (channel === "latest" && prerelease) {
    fail("the latest tag requires a stable version without a prerelease suffix");
  }
}

function checkStrictSemver(version, label) {
  if (!SEMVER_STRICT.test(version)) {
    fail(
      `${label} '${sanitize(version)}' is not strict semver ` +
        "(no leading v, no leading zeros, no empty prerelease ids, " +
        "no leading-zero numeric prerelease ids, no build metadata)",
    );
  }
  return version;
}

function readManifestVersion() {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(repoRoot, "plugin", "package.json"), "utf8"),
    );
  } catch {
    fail("cannot read plugin/package.json");
  }
  if (typeof manifest.version !== "string") fail("plugin/package.json version is not a string");
  checkStrictSemver(manifest.version, "plugin/package.json version");
  return manifest.version;
}

function doPrepare() {
  const version = need("INPUT_VERSION");
  const channel = need("INPUT_DIST_TAG");
  const confirm = need("INPUT_CONFIRM");
  const refType = need("REF_TYPE");
  const refName = need("REF_NAME");
  checkStrictSemver(version, "input version");
  if (refType !== "branch") {
    fail("refusing prepare: tag dispatches are rejected (dispatch from the branch)");
  }
  if (confirm !== "PREPARE") fail("refusing prepare: 'confirm' must be exactly PREPARE");
  checkChannel(version, channel);
  checkBranch(refName, "release ref");
  if (channel === "latest" && refName !== "main") {
    fail("the latest tag publishes only from 'main' (release/* is beta-only)");
  }
  const pkgVersion = readManifestVersion();
  if (pkgVersion !== version) {
    fail(
      `input version '${sanitize(version)}' does not match plugin/package.json '${sanitize(pkgVersion)}'`,
    );
  }
  process.stdout.write(
    `release-policy prepare ok: version=${sanitize(version)} tag=${sanitize(channel)} ref=${sanitize(refName)}\n`,
  );
}

function doPublish() {
  const version = need("INPUT_VERSION");
  const channel = need("INPUT_DIST_TAG");
  const confirm = need("INPUT_CONFIRM");
  const sha256 = need("EXPECTED_SHA256");
  const sha512 = need("EXPECTED_SHA512");
  const prepareRunId = need("PREPARE_RUN_ID");
  const currentRunId = need("CURRENT_RUN_ID");
  const sourceSha = need("SOURCE_SHA");
  const sourceBranch = need("SOURCE_BRANCH");
  const killSwitch = need("NPM_PUBLISH_ENABLED");
  checkStrictSemver(version, "input version");
  if (confirm !== "PUBLISH") fail("refusing publish: 'confirm' must be exactly PUBLISH");
  checkChannel(version, channel);
  if (channel === "latest" && sourceBranch !== "main") {
    fail("the latest tag publishes only from 'main' (release/* is beta-only)");
  }
  if (!SHA256.test(sha256)) fail("expected_sha256 must be canonical lowercase hex (64 chars)");
  if (!INTEGRITY.test(sha512)) fail("expected_sha512 must be canonical 'sha512-<base64==>' integrity");
  if (!RUN_ID.test(prepareRunId)) fail("prepare_run_id must be a numeric workflow run ID");
  if (!RUN_ID.test(currentRunId)) fail("current run ID is not numeric");
  if (prepareRunId === currentRunId) fail("prepare_run_id must be an earlier run, not the current run");
  if (!COMMIT_SHA.test(sourceSha)) fail("source_sha must be a 40-char lowercase commit SHA");
  checkBranch(sourceBranch, "source branch");
  if (killSwitch !== "true") {
    fail("refusing publish: repository variable NPM_PUBLISH_ENABLED must be exactly 'true'");
  }
  process.stdout.write(
    `release-policy publish inputs ok: version=${sanitize(version)} tag=${sanitize(channel)} run=${sanitize(prepareRunId)} branch=${sanitize(sourceBranch)}\n`,
  );
}

function candidateFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail(`candidate dir is not readable: ${sanitize(dir)}`);
  }
  const tgz = entries.filter((n) => n.endsWith(".tgz")).sort();
  if (tgz.length !== 1) fail(`candidate dir must hold exactly one .tgz (found ${tgz.length})`);
  const base = tgz[0];
  for (const sidecar of [`${base}.sha256`, `${base}.integrity`]) {
    if (!entries.includes(sidecar)) fail(`candidate dir is missing sidecar ${sanitize(sidecar)}`);
  }
  return { dir, base };
}

function verifyCandidateBytesSync(dir, base) {
  let bytes;
  try {
    bytes = readFileSync(join(dir, base));
  } catch {
    fail(`cannot read candidate tarball ${sanitize(base)}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const sha256Sidecar = readFileSync(join(dir, `${base}.sha256`), "utf8").trim();
  const sha512Sidecar = readFileSync(join(dir, `${base}.integrity`), "utf8").trim();
  if ((sha256Sidecar.split(/\s+/)[0] ?? "") !== sha256) {
    fail("candidate .sha256 sidecar does not match tarball bytes");
  }
  if (sha512Sidecar !== sha512) fail("candidate .integrity sidecar does not match tarball bytes");
  return { sha256, sha512, size: bytes.length };
}

function doWriteProof() {
  const dir = resolve(repoRoot, need("CANDIDATE_DIR"));
  const sourceSha = need("SOURCE_SHA");
  const runId = need("RUN_ID");
  const workflowName = need("WORKFLOW_NAME");
  const repository = need("REPOSITORY");
  if (!COMMIT_SHA.test(sourceSha)) fail("SOURCE_SHA must be a 40-char lowercase commit SHA");
  if (!RUN_ID.test(runId)) fail("RUN_ID must be numeric");
  if (!workflowName) fail("WORKFLOW_NAME is not valid");
  if (!REPO.test(repository)) fail("REPOSITORY is not owner/repo");
  const { base } = candidateFiles(dir);
  const version = readManifestVersion();
  const expectedBase = `opencode-spotify-${version}.tgz`;
  if (base !== expectedBase) {
    fail(
      `candidate tarball name '${sanitize(base)}' does not match version '${sanitize(version)}'`,
    );
  }
  const { sha256, sha512 } = verifyCandidateBytesSync(dir, base);
  const proof = {
    source_sha: sourceSha,
    version,
    sha256,
    sha512,
    verifier: VERIFIER_ID,
    run_id: runId,
    workflow: workflowName,
    repository,
  };
  writeFileSync(join(dir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(
    `release-policy proof ok: version=${sanitize(version)} sha256=${sha256} run=${sanitize(runId)}\n`,
  );
}

function doRecheck() {
  const dir = resolve(repoRoot, need("CANDIDATE_DIR"));
  const version = need("INPUT_VERSION");
  const expectedSha256 = need("EXPECTED_SHA256");
  const expectedSha512 = need("EXPECTED_SHA512");
  const sourceSha = need("SOURCE_SHA");
  const expectedRunId = need("PREPARE_RUN_ID");
  const expectedRepo = need("EXPECTED_REPOSITORY");
  checkStrictSemver(version, "INPUT_VERSION");
  if (!SHA256.test(expectedSha256)) fail("EXPECTED_SHA256 must be canonical lowercase hex");
  if (!INTEGRITY.test(expectedSha512)) fail("EXPECTED_SHA512 must be canonical integrity");
  if (!COMMIT_SHA.test(sourceSha)) fail("SOURCE_SHA must be a 40-char commit SHA");
  if (!RUN_ID.test(expectedRunId)) fail("PREPARE_RUN_ID must be numeric");
  if (!REPO.test(expectedRepo)) fail("EXPECTED_REPOSITORY is not owner/repo");
  const base = `opencode-spotify-${version}.tgz`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(base)) fail("candidate tarball name is not safe");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail("candidate dir is not readable");
  }
  for (const required of [base, `${base}.sha256`, `${base}.integrity`, "proof.json"]) {
    if (!entries.includes(required)) fail(`downloaded candidate is missing ${sanitize(required)}`);
  }
  const { sha256, sha512 } = verifyCandidateBytesSync(dir, base);
  if (sha256 !== expectedSha256) fail("downloaded tarball SHA-256 does not match QA attestation");
  if (sha512 !== expectedSha512) fail("downloaded tarball integrity does not match QA attestation");
  let proof;
  try {
    proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
  } catch {
    fail("candidate proof.json is not valid JSON");
  }
  if (proof.version !== version) fail("candidate proof version does not match release version");
  if (proof.source_sha !== sourceSha) {
    fail("candidate proof source SHA does not match QA attestation");
  }
  if (proof.sha256 !== expectedSha256 || proof.sha512 !== expectedSha512) {
    fail("candidate proof digests do not match QA attestation");
  }
  if (String(proof.run_id ?? "") !== expectedRunId) {
    fail("candidate proof run_id does not match the validated prepare run");
  }
  if (proof.repository !== expectedRepo) {
    fail("candidate proof repository does not match this repository");
  }
  if (proof.verifier !== VERIFIER_ID) {
    fail(`candidate proof verifier identity is unexpected (want ${VERIFIER_ID})`);
  }
  process.stdout.write(
    `release-policy recheck ok: version=${sanitize(version)} sha256=${sanitize(sha256)}\n`,
  );
}

function parseStrictParts(version, label) {
  const m = SEMVER_STRICT.exec(version);
  if (!m) fail(`${label} '${sanitize(version)}' is not strict semver`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].slice(1).split(".") : null,
  };
}

// semver.org item 11: numeric identifiers compare numerically, alphanumeric
// identifiers compare lexically in ASCII sort order, numeric identifiers have
// lower precedence than alphanumeric ones, and a larger set of identifiers
// has higher precedence only when all preceding identifiers are equal. A
// version without a prerelease outranks the same core with one.
function compareIdentifiers(a, b) {
  const aNum = /^[0-9]+$/.test(a);
  const bNum = /^[0-9]+$/.test(b);
  if (aNum && bNum) {
    if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    return 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

function compareSemver(a, b) {
  const A = parseStrictParts(a, "release version");
  const B = parseStrictParts(b, "registry version");
  for (const k of ["major", "minor", "patch"]) {
    if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i++) {
    if (i >= A.pre.length) return -1;
    if (i >= B.pre.length) return 1;
    const c = compareIdentifiers(A.pre[i], B.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function doTagRelease() {
  const refType = need("REF_TYPE");
  let tagName = needOpt("TAG_NAME");
  if (!tagName) tagName = needOpt("REF_NAME");
  if (!tagName) fail("missing required env TAG_NAME");
  if (refType !== "tag") {
    fail(`refusing tag-release: REF_TYPE is '${sanitize(refType)}', want 'tag' (push a version tag)`);
  }
  if (!tagName.startsWith("v")) {
    fail(`tag name '${sanitize(tagName)}' must start with 'v' followed by strict semver (e.g. v0.6.0 or v0.6.0-beta.4)`);
  }
  const version = tagName.slice(1);
  checkStrictSemver(version, "tag version");
  if (version.includes("-")) {
    const pre = version.slice(version.indexOf("-") + 1);
    if (!/^beta\.(0|[1-9]\d*)$/.test(pre)) {
      fail(
        `tag prerelease '${sanitize(pre)}' is not an accepted prerelease (only -beta.N tags publish; stable tags publish to latest)`,
      );
    }
  }
  const pkgVersion = readManifestVersion();
  if (pkgVersion !== version) {
    fail(
      `tag version '${sanitize(version)}' does not match plugin/package.json '${sanitize(pkgVersion)}'`,
    );
  }
  const channel = version.includes("-") ? "beta" : "latest";
  const lines = `version=${version}\ndist_tag=${channel}\n`;
  const githubOutput = process.env.GITHUB_OUTPUT ?? "";
  if (/[\r\n]/.test(githubOutput)) fail("GITHUB_OUTPUT must be single-line");
  if (githubOutput) {
    try {
      writeFileSync(githubOutput, lines, { flag: "a" });
    } catch {
      fail("cannot append tag-release outputs to GITHUB_OUTPUT");
    }
  }
  process.stdout.write(lines);
}

function doTagPreflight() {
  const version = need("INPUT_VERSION");
  const channel = need("INPUT_DIST_TAG");
  const current = needOpt("CURRENT_TAG");
  checkStrictSemver(version, "INPUT_VERSION");
  if (channel !== "beta" && channel !== "latest") {
    fail(`dist-tag must be beta or latest (got ${sanitize(channel)})`);
  }
  if (!current) {
    process.stdout.write(
      `release-policy tag-preflight ok: tag '${sanitize(channel)}' is missing on the registry (first use); version ${sanitize(version)} may claim it\n`,
    );
    return;
  }
  checkStrictSemver(current, "registry dist-tag target");
  const cmp = compareSemver(version, current);
  if (cmp <= 0) {
    fail(
      `refusing: version ${sanitize(version)} does not move dist-tag '${sanitize(channel)}' forward from ${sanitize(current)} (strict SemVer, prerelease precedence applies)`,
    );
  }
  process.stdout.write(
    `release-policy tag-preflight ok: ${sanitize(version)} > ${sanitize(current)} for tag '${sanitize(channel)}'\n`,
  );
}

const mode = process.argv[2] ?? "";
if (mode === "prepare") doPrepare();
else if (mode === "publish") doPublish();
else if (mode === "write-proof") doWriteProof();
else if (mode === "recheck") doRecheck();
else if (mode === "tag-release") doTagRelease();
else if (mode === "tag-preflight") doTagPreflight();
else {
  process.stderr.write(
    `release-policy: unknown mode ${sanitize(mode)} (want prepare|publish|write-proof|recheck|tag-release|tag-preflight)\n`,
  );
  process.exit(1);
}
