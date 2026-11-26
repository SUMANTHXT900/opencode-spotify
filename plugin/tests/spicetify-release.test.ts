// B26 — dynamic Spicetify release resolution. No real network: every fetch is
// injected, and all versions are synthetic (9.9.9 / 9.10.0). No test imports a
// static install target.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStableVersion,
  releaseArchToken,
  resolveSpicetifyRelease,
  spicetifyReleaseAsset,
  windowsAssetName,
} from "../src/cli/spicetify-release.ts";
import {
  FUTURE_TAG,
  FUTURE_VERSION,
  NEWER_VERSION,
  assetUrl,
  futureRelease,
  futureReleasePayload,
  jsonResponse,
  releaseResponse,
  scriptedFetcher,
  windowsAsset,
} from "./release-fixture.ts";

function malformedTag(tag: unknown): Response {
  return releaseResponse({ payload: { ...futureReleasePayload(), tag_name: tag } });
}

test("parseStableVersion is strict: optional v, no prerelease/build/leading zeros/text", () => {
  assert.equal(parseStableVersion("9.9.9"), "9.9.9");
  assert.equal(parseStableVersion("v9.9.9"), "9.9.9");
  assert.equal(parseStableVersion("  v9.9.9  "), "9.9.9");
  assert.equal(parseStableVersion("02.46.7"), null);
  assert.equal(parseStableVersion("9.9"), null);
  assert.equal(parseStableVersion("v9.9.9-rc.1"), null);
  assert.equal(parseStableVersion("v9.9.9+build"), null);
  assert.equal(parseStableVersion("nightly"), null);
  assert.equal(parseStableVersion("release-v9.9.9"), null);
  assert.equal(parseStableVersion("9.9.9\n9.10.0"), null);
  assert.equal(parseStableVersion(null), null);
  assert.equal(parseStableVersion(999), null);
});

test("resolveSpicetifyRelease accepts a future stable release and sends the pinned GitHub headers", async () => {
  const { fetcher, calls } = scriptedFetcher([
    releaseResponse({ version: FUTURE_VERSION, archs: ["x64", "arm64"] }),
  ]);
  const result = await resolveSpicetifyRelease({
    fetcher,
    arch: "x64",
    requireWindowsAsset: true,
    now: 1_800_000_000_000,
  });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.error}`);
  if (!result.ok) return;

  assert.equal(result.release.version, FUTURE_VERSION);
  assert.equal(result.release.tag, FUTURE_TAG);
  assert.equal(result.release.source, "github");
  assert.equal(result.release.releaseId, 424_242);
  assert.equal(result.release.fetchedAt, 1_800_000_000_000);
  assert.equal(result.release.assets.length, 2);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/spicetify/cli/releases/latest");
  const init = calls[0]!.init!;
  assert.equal(init.redirect, "error");
  assert.equal(init.method, "GET");
  assert.ok(init.signal, "a 12s timeout signal is always attached");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.match(headers.get("user-agent") ?? "", /opencode-spotify-installer/);
  assert.equal(headers.get("cache-control"), "no-cache");

  const asset = spicetifyReleaseAsset(result.release, "x64");
  assert.equal(asset?.name, windowsAssetName(FUTURE_VERSION, "x64"));
  assert.equal(asset?.url, assetUrl(FUTURE_VERSION, windowsAssetName(FUTURE_VERSION, "x64")));
  assert.match(asset?.digest ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("draft, prerelease and 404 responses fail closed with distinct codes", async () => {
  const prerelease = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({ version: FUTURE_VERSION, prerelease: true }),
  });
  assert.equal(prerelease.ok, false);
  if (!prerelease.ok) assert.equal(prerelease.code, "E_RELEASE_PRERELEASE");

  const draft = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({ version: FUTURE_VERSION, draft: true }),
  });
  assert.equal(draft.ok, false);
  if (!draft.ok) assert.equal(draft.code, "E_RELEASE_INVALID");

  const missing = await resolveSpicetifyRelease({
    fetcher: async () => new Response("Not Found", { status: 404 }),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "E_RELEASE_LOOKUP");
    assert.match(missing.error, /404/);
  }
});

test("rate limits are reported with the reset hint and never a fallback target", async () => {
  const limited = await resolveSpicetifyRelease({
    now: 1_800_000_000_000,
    fetcher: async () => new Response("{}", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(1_800_000_000 + 60),
      },
    }),
  });
  assert.equal(limited.ok, false);
  if (!limited.ok) {
    assert.equal(limited.code, "E_RATE_LIMIT");
    assert.equal(limited.retryAfter, 60);
    assert.match(limited.error, /rate limit/i);
  }

  const retryAfter = await resolveSpicetifyRelease({
    fetcher: async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
  });
  assert.equal(retryAfter.ok, false);
  if (!retryAfter.ok) {
    assert.equal(retryAfter.code, "E_RATE_LIMIT");
    assert.equal(retryAfter.retryAfter, 30);
  }
});

test("invalid tags are rejected before any approval or child process", async () => {
  for (const tag of ["v9.9", "v9.9.9-rc.1", "v9.9.9+build", "nightly", "v09.9.9", 123, null]) {
    const result = await resolveSpicetifyRelease({
      fetcher: async () => malformedTag(tag),
      arch: "x64",
      requireWindowsAsset: true,
    });
    assert.equal(result.ok, false, String(tag));
    if (!result.ok) assert.equal(result.code, "E_RELEASE_INVALID", String(tag));
  }
});

test("a release without the exact Windows asset is refused before approval", async () => {
  const missingArm = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({ version: FUTURE_VERSION, archs: ["x64"] }),
    arch: "arm64",
    requireWindowsAsset: true,
  });
  assert.equal(missingArm.ok, false);
  if (!missingArm.ok) {
    assert.equal(missingArm.code, "E_RELEASE_ASSET");
    assert.match(missingArm.error, /spicetify-9\.9\.9-windows-arm64\.zip/);
  }

  const arm = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({ version: FUTURE_VERSION, archs: ["arm64"] }),
    arch: "arm64",
    requireWindowsAsset: true,
  });
  assert.equal(arm.ok, true);
  if (arm.ok) assert.equal(spicetifyReleaseAsset(arm.release, "arm64")?.name, "spicetify-9.9.9-windows-arm64.zip");

  const unknown = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({ version: FUTURE_VERSION }),
    arch: "mips",
    requireWindowsAsset: true,
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "E_RELEASE_UNSUPPORTED");
});

test("non-GitHub asset URLs are refused even when the expected name is present", async () => {
  const result = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({
      version: FUTURE_VERSION,
      assets: [{
        name: windowsAssetName(FUTURE_VERSION, "x64"),
        size: 1,
        digest: null,
        url: "https://evil.example.com/spicetify-9.9.9-windows-x64.zip",
      }],
    }),
    arch: "x64",
    requireWindowsAsset: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "E_RELEASE_ASSET");
});

test("offline mode performs zero fetches and a below-minimum release is unsupported", async () => {
  let calls = 0;
  const offline = await resolveSpicetifyRelease({
    offline: true,
    fetcher: async () => { calls += 1; return releaseResponse(); },
  });
  assert.equal(offline.ok, false);
  if (!offline.ok) assert.equal(offline.code, "E_OFFLINE");
  assert.equal(calls, 0);

  const old = await resolveSpicetifyRelease({
    fetcher: async () => releaseResponse({ version: "1.9.9" }),
    arch: "x64",
    requireWindowsAsset: true,
  });
  assert.equal(old.ok, false);
  if (!old.ok) assert.equal(old.code, "E_RELEASE_UNSUPPORTED");
});

test("malformed metadata, oversized bodies and network failures are explicit", async () => {
  const notJson = await resolveSpicetifyRelease({ fetcher: async () => new Response("not json", { status: 200 }) });
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.code, "E_RELEASE_INVALID");

  const notObject = await resolveSpicetifyRelease({ fetcher: async () => jsonResponse([1, 2, 3]) });
  assert.equal(notObject.ok, false);
  if (!notObject.ok) assert.equal(notObject.code, "E_RELEASE_INVALID");

  const oversized = await resolveSpicetifyRelease({
    fetcher: async () => new Response("{}", { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }),
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "E_RELEASE_INVALID");

  const failed = await resolveSpicetifyRelease({ fetcher: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, "E_RELEASE_LOOKUP");
    assert.match(failed.error, /ECONNRESET/);
  }
});

test("the metadata cap is measured in UTF-8 bytes, not UTF-16 code units (L10)", async () => {
  // 300k characters, 600k UTF-8 bytes: the old text.length guard passed it.
  const multibyte = "é".repeat(300_000);
  assert.ok(multibyte.length < 512 * 1024);
  assert.ok(Buffer.byteLength(multibyte, "utf8") > 512 * 1024);

  const capped = await resolveSpicetifyRelease({
    fetcher: async () => new Response(multibyte, { status: 200 }),
  });
  assert.equal(capped.ok, false);
  if (!capped.ok) {
    assert.equal(capped.code, "E_RELEASE_INVALID");
    assert.match(capped.error, /512 KiB cap/);
  }

  // A multibyte body under the byte cap is still accepted.
  const small = await resolveSpicetifyRelease({
    fetcher: async () => new Response(JSON.stringify({ ...futureReleasePayload(), note: "é".repeat(1000) }), { status: 200 }),
    arch: "x64",
    requireWindowsAsset: true,
  });
  assert.equal(small.ok, true, small.ok ? "" : small.error);
});

test("architecture mapping and fixture helpers do not invent a version", () => {
  assert.equal(releaseArchToken("AMD64"), "x64");
  assert.equal(releaseArchToken("arm64"), "arm64");
  assert.equal(releaseArchToken("ia32"), "x32");
  assert.equal(releaseArchToken("mips"), null);
  assert.equal(releaseArchToken(undefined), null);

  assert.equal(futureRelease().version, FUTURE_VERSION);
  assert.equal(futureRelease({ version: NEWER_VERSION }).version, NEWER_VERSION);
  assert.equal(windowsAsset("9.9.9", "x32").name, "spicetify-9.9.9-windows-x32.zip");
});
