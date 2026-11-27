import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPICETIFY_MARKETPLACE_REPO } from "../src/cli/compat.ts";
import {
  inspectMarketplace,
  installMarketplace,
  listZipEntryNames,
  resolveMarketplaceRelease,
} from "../src/cli/marketplace.ts";
import { createCancelToken } from "../src/cli/cancel.ts";
import type { Runtime } from "../src/cli/types.ts";

function makeZip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(enc.encode(entry.name));
    const dataBuf = Buffer.from(enc.encode(entry.content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, dataBuf);
    const headerOffset = offset;
    offset += local.length + nameBuf.length + dataBuf.length;
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(headerOffset, 42);
    central.push(cd, nameBuf);
  }
  const cdStart = offset;
  const cdSize = central.reduce((sum, buf) => sum + buf.length, 0);
  offset += cdSize;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  void offset;
  return new Uint8Array(Buffer.concat([...chunks, ...central, eocd]));
}

function memRuntime(files: Map<string, string>): Runtime & { calls: string[] } {
  const calls: string[] = [];
  const norm = (p: string) => p.toLowerCase();
  const lower = new Map<string, string>();
  for (const [k, v] of files) lower.set(norm(k), v);
  return {
    calls,
    platform: "win32",
    arch: "x64",
    env: { APPDATA: "C:\\Users\\Test\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" } as NodeJS.ProcessEnv,
    cwd: "C:\\x",
    homedir: "C:\\Users\\Test",
    async run(file: string, args: string[]) {
      calls.push(`${file} ${args.join(" ")}`);
      throw new Error("must not run in detection");
    },
    async which() {
      calls.push("which");
      return undefined;
    },
    exists: (p: string) => lower.has(norm(p)),
    isFile: (p: string) => lower.has(norm(p)),
    readText: (p: string) => {
      const v = lower.get(norm(p));
      if (v === undefined) throw new Error("missing");
      return v;
    },
    writeText: () => { throw new Error("must not write in detection"); },
    copyFile: () => { throw new Error("must not copy"); },
    mkdir: () => { throw new Error("must not mkdir"); },
    remove: () => { throw new Error("must not remove"); },
    now: () => 0,
    async portOpen() { return false; },
  } as unknown as Runtime & { calls: string[] };
}

function realRuntime(appData: string, runImpl: (file: string, args: string[], options?: { env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string; cancelled?: boolean }>): Runtime & { runCalls: Array<{ file: string; args: string[]; env?: Record<string, string> }> } {
  const runCalls: Array<{ file: string; args: string[]; env?: Record<string, string> }> = [];
  const runtime = {
    runCalls,
    platform: "win32",
    arch: "x64",
    env: { APPDATA: appData, LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local", PATH: "C:\\Windows" } as NodeJS.ProcessEnv,
    cwd: "C:\\x",
    homedir: "C:\\Users\\Test",
    async run(file: string, args: string[], options?: { env?: Record<string, string> }) {
      runCalls.push({ file, args: [...args], env: options?.env });
      return runImpl(file, args, options);
    },
    async which(name: string) {
      if (name === "spicetify") return "C:\\sp.exe";
      if (name === "pwsh") return "C:\\pwsh.exe";
      return undefined;
    },
    exists: (p: string) => { try { return existsSync(p); } catch { return false; } },
    isFile: (p: string) => { try { return statSync(p).isFile(); } catch { return false; } },
    readText: (p: string) => readFileSync(p, "utf8"),
    writeText: (p: string, v: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, v, "utf8"); },
    copyFile: () => {},
    mkdir: (p: string) => { mkdirSync(p, { recursive: true }); },
    remove: (p: string) => { rmSync(p, { recursive: true, force: true }); },
    now: () => 0,
    async portOpen() { return false; },
  } as unknown as Runtime & { runCalls: Array<{ file: string; args: string[]; env?: Record<string, string> }> };
  return runtime;
}

function marketplacePayload(version = "v1.0.0") {
  return {
    tag_name: version,
    draft: false,
    prerelease: false,
    id: 1,
    published_at: "2026-01-01T00:00:00Z",
    assets: [
      {
        name: "marketplace.zip",
        size: 100,
        browser_download_url: `https://github.com/spicetify/marketplace/releases/download/${version}/marketplace.zip`,
      },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("marketplace repo constant is exact", () => {
  assert.equal(SPICETIFY_MARKETPLACE_REPO, "spicetify/marketplace");
});

test("detection reports installed+registered only when index, manifest and config agree", () => {
  const dir = "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\CustomApps\\marketplace";
  const config = "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini";
  const full = new Map([
    [`${dir}\\index.js`, "js"],
    [`${dir}\\manifest.json`, "{}"],
    [config, "[AdditionalOptions]\ncustom_apps = marketplace\n"],
  ]);
  const ok = inspectMarketplace(memRuntime(full), { configPath: config } as never);
  assert.equal(ok.installed, true);
  assert.equal(ok.registered, true);

  const missingManifest = new Map([
    [`${dir}\\index.js`, "js"],
    [config, "[AdditionalOptions]\ncustom_apps = marketplace\n"],
  ]);
  const notInstalled = inspectMarketplace(memRuntime(missingManifest), { configPath: config } as never);
  assert.equal(notInstalled.installed, false);
  assert.equal(notInstalled.registered, true);

  const unregistered = new Map([
    [`${dir}\\index.js`, "js"],
    [`${dir}\\manifest.json`, "{}"],
    [config, "[AdditionalOptions]\ncustom_apps = \n"],
  ]);
  const notRegistered = inspectMarketplace(memRuntime(unregistered), { configPath: config } as never);
  assert.equal(notRegistered.installed, true);
  assert.equal(notRegistered.registered, false);
});

test("detection is read-only with zero side effects", () => {
  const dir = "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\CustomApps\\marketplace";
  const config = "C:\\Users\\Test\\AppData\\Roaming\\spicetify\\config-xpui.ini";
  const runtime = memRuntime(new Map([[config, "custom_apps=marketplace"]]));
  void dir;
  const before = runtime.calls.length;
  inspectMarketplace(runtime, { configPath: config } as never);
  assert.equal(runtime.calls.length, before);
});

test("release resolution validates a .zip asset with the verified prefix", async () => {
  const ok = await resolveMarketplaceRelease({
    fetcher: (async () => jsonResponse(marketplacePayload("v2.5.0"))) as typeof fetch,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.release.assetName, "marketplace.zip");
    assert.match(ok.release.assetUrl, /^https:\/\/github\.com\/spicetify\/marketplace\/releases\/download\//);
  }

  const wrongHost = await resolveMarketplaceRelease({
    fetcher: (async () => jsonResponse({
      ...marketplacePayload("v2.5.0"),
      assets: [{ name: "marketplace.zip", size: 1, browser_download_url: "https://evil.example/marketplace.zip" }],
    })) as typeof fetch,
  });
  assert.equal(wrongHost.ok, false);
  if (!wrongHost.ok) assert.equal(wrongHost.code, "E_RELEASE_ASSET");

  const noZip = await resolveMarketplaceRelease({
    fetcher: (async () => jsonResponse({
      ...marketplacePayload("v2.5.0"),
      assets: [{ name: "notes.txt", size: 1, browser_download_url: "https://github.com/spicetify/marketplace/releases/download/v2.5.0/notes.txt" }],
    })) as typeof fetch,
  });
  assert.equal(noZip.ok, false);

  const offline = await resolveMarketplaceRelease({ offline: true, fetcher: (async () => { throw new Error("must not fetch"); }) as typeof fetch });
  assert.equal(offline.ok, false);
  if (!offline.ok) assert.equal(offline.code, "E_OFFLINE");

  const cancelled = createCancelToken();
  cancelled.request("user");
  const cancelRes = await resolveMarketplaceRelease({
    cancel: cancelled,
    fetcher: (async () => { throw new Error("must not fetch when cancelled"); }) as typeof fetch,
  });
  assert.equal(cancelRes.ok, false);
});

test("zip traversal entries are rejected before extraction", () => {
  const evil = makeZip([{ name: "../evil.js", content: "x" }]);
  assert.deepEqual(listZipEntryNames(evil), ["../evil.js"]);
  const rooted = makeZip([{ name: "/abs.js", content: "x" }]);
  assert.deepEqual(listZipEntryNames(rooted), ["/abs.js"]);
  const flat = makeZip([
    { name: "manifest.json", content: "{}" },
    { name: "index.js", content: "x" },
  ]);
  assert.deepEqual(listZipEntryNames(flat)?.sort(), ["index.js", "manifest.json"]);
});

test("already-installed touches nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-installed-"));
  try {
    const appData = join(root, "Roaming");
    const dir = join(appData, "spicetify", "CustomApps", "marketplace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), "x", "utf8");
    writeFileSync(join(dir, "manifest.json"), "{}", "utf8");
    const config = join(appData, "spicetify", "config-xpui.ini");
    mkdirSync(join(appData, "spicetify"), { recursive: true });
    writeFileSync(config, "[AdditionalOptions]\ncustom_apps = marketplace\n", "utf8");
    const runtime = realRuntime(appData, async () => { throw new Error("must not run when already installed"); });
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: config } as never, {
      fetcher: (async () => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    assert.equal(result.status, "already-installed");
    assert.equal(runtime.runCalls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run performs zero network/disk writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-dry-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async () => { throw new Error("must not run on dry-run"); });
    const before = existsSync(join(appData, "spicetify", "CustomApps", "marketplace"));
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      dryRun: true,
      fetcher: (async () => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    assert.equal(result.status, "dry-run");
    assert.equal(runtime.runCalls.length, 0);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline returns skipped-offline guidance without side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-off-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async () => { throw new Error("must not run offline"); });
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      offline: true,
      fetcher: (async () => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    assert.equal(result.status, "skipped-offline");
    assert.match((result as { guidance: string }).guidance, /github\.com\/spicetify\/marketplace/);
    assert.equal(runtime.runCalls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel returns failed without side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-cancel-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async () => { throw new Error("must not run when cancelled"); });
    const token = createCancelToken();
    token.request("user");
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      cancel: token,
      fetcher: (async () => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    assert.equal(result.status, "failed");
    assert.equal(runtime.runCalls.length, 0);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("traversal zip fails soft without extraction or registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-trav-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async () => { throw new Error("must not run on traversal"); });
    let extracted = 0;
    const evil = makeZip([
      { name: "../evil.js", content: "x" },
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "x" },
    ]);
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      zipBytes: evil,
      release: {
        version: "1.0.0",
        tag: "v1.0.0",
        assetName: "marketplace.zip",
        assetUrl: "https://github.com/spicetify/marketplace/releases/download/v1.0.0/marketplace.zip",
        size: evil.length,
        releaseId: 1,
        publishedAt: null,
        fetchedAt: 0,
      },
      extractZip: async () => { extracted += 1; },
    });
    assert.equal(result.status, "failed");
    assert.match((result as { error: string }).error, /traversal|unsafe|E_TRAVERSAL/i);
    assert.equal(extracted, 0);
    assert.equal(runtime.runCalls.length, 0);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat zip installs and registers via spicetify config", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-flat-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async (file) => {
      if (file === "C:\\sp.exe") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected run: ${file}`);
    });
    const zip = makeZip([
      { name: "manifest.json", content: "{\"name\":\"marketplace\"}" },
      { name: "index.js", content: "console.log(1)" },
    ]);
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      zipBytes: zip,
      release: {
        version: "1.0.0",
        tag: "v1.0.0",
        assetName: "marketplace.zip",
        assetUrl: "https://github.com/spicetify/marketplace/releases/download/v1.0.0/marketplace.zip",
        size: zip.length,
        releaseId: 1,
        publishedAt: null,
        fetchedAt: 0,
      },
      extractZip: async (zipPath, destDir) => {
        assert.equal(existsSync(zipPath), true);
        writeFileSync(join(destDir, "manifest.json"), "{\"name\":\"marketplace\"}", "utf8");
        writeFileSync(join(destDir, "index.js"), "console.log(1)", "utf8");
      },
    });
    assert.equal(result.status, "installed", (result as { error?: string }).error);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace", "manifest.json")), true);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace", "index.js")), true);
    const cmds = runtime.runCalls.map((c) => `${c.file} ${c.args.join(" ")}`);
    assert.ok(cmds.some((c) => c === "C:\\sp.exe config custom_apps marketplace"));
    assert.ok(cmds.every((c) => !c.includes("inject_css") && !c.includes("replace_colors") && !c.includes("overwrite_assets") && !c.includes("color_scheme") && !c.includes("current_theme")),
      "Marketplace install must not write any theme config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-nested zip installs from the inner folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-nested-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async () => ({ code: 0, stdout: "", stderr: "" }));
    const zip = makeZip([
      { name: "marketplace-dist/manifest.json", content: "{}" },
      { name: "marketplace-dist/index.js", content: "x" },
    ]);
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      zipBytes: zip,
      release: {
        version: "1.0.0",
        tag: "v1.0.0",
        assetName: "marketplace.zip",
        assetUrl: "https://github.com/spicetify/marketplace/releases/download/v1.0.0/marketplace.zip",
        size: zip.length,
        releaseId: 1,
        publishedAt: null,
        fetchedAt: 0,
      },
      extractZip: async (_zipPath, destDir) => {
        const inner = join(destDir, "marketplace-dist");
        mkdirSync(inner, { recursive: true });
        writeFileSync(join(inner, "manifest.json"), "{}", "utf8");
        writeFileSync(join(inner, "index.js"), "x", "utf8");
      },
    });
    assert.equal(result.status, "installed", (result as { error?: string }).error);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace", "manifest.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production extraction uses PowerShell with env paths and no Invoke-Expression", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-pwsh-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async (file, args, options) => {
      if (file === "C:\\pwsh.exe") {
        const script = args.join("\n");
        assert.doesNotMatch(script, /Invoke-Expression/);
        assert.match(script, /Expand-Archive/);
        const dest = options?.env?.SPX_MP_DEST;
        const zip = options?.env?.SPX_MP_ZIP;
        assert.ok(dest && zip, "env-passed paths are required");
        assert.equal(existsSync(zip), true);
        writeFileSync(join(dest, "manifest.json"), "{}", "utf8");
        writeFileSync(join(dest, "index.js"), "x", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (file === "C:\\sp.exe") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected: ${file}`);
    });
    const zip = makeZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "x" },
    ]);
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      zipBytes: zip,
      release: {
        version: "1.0.0",
        tag: "v1.0.0",
        assetName: "marketplace.zip",
        assetUrl: "https://github.com/spicetify/marketplace/releases/download/v1.0.0/marketplace.zip",
        size: zip.length,
        releaseId: 1,
        publishedAt: null,
        fetchedAt: 0,
      },
    });
    assert.equal(result.status, "installed", (result as { error?: string }).error);
    const pwshCalls = runtime.runCalls.filter((c) => c.file === "C:\\pwsh.exe");
    assert.equal(pwshCalls.length, 1);
    assert.doesNotMatch(pwshCalls[0]!.args.join(" "), /Invoke-Expression/);
    assert.ok(pwshCalls[0]!.env?.SPX_MP_ZIP && pwshCalls[0]!.env?.SPX_MP_DEST);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("soft failure isolates errors and sanitizes secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-fail-"));
  try {
    const appData = join(root, "Roaming");
    const secret = "9f".repeat(32);
    const runtime = realRuntime(appData, async () => ({ code: 1, stdout: "", stderr: `boom secret=${secret}` }));
    const zip = makeZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "x" },
    ]);
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      zipBytes: zip,
      release: {
        version: "1.0.0",
        tag: "v1.0.0",
        assetName: "marketplace.zip",
        assetUrl: "https://github.com/spicetify/marketplace/releases/download/v1.0.0/marketplace.zip",
        size: zip.length,
        releaseId: 1,
        publishedAt: null,
        fetchedAt: 0,
      },
      extractZip: async (_zipPath, destDir) => {
        writeFileSync(join(destDir, "manifest.json"), "{}", "utf8");
        writeFileSync(join(destDir, "index.js"), "x", "utf8");
      },
    });
    assert.equal(result.status, "failed");
    const error = (result as { error: string }).error;
    assert.ok(!error.includes(secret), "secrets must be redacted");
    assert.match(error, /E_REGISTER|failed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function zipResponse(zip: Uint8Array): Response {
  return new Response(Buffer.from(zip), {
    status: 200,
    headers: { "content-type": "application/zip", "content-length": String(zip.length) },
  });
}

function testRelease(zip: Uint8Array) {
  return {
    version: "9.9.9",
    tag: "v9.9.9",
    assetName: "marketplace.zip",
    assetUrl: "https://github.com/spicetify/marketplace/releases/download/v9.9.9/marketplace.zip",
    size: zip.length,
    releaseId: 9,
    publishedAt: null,
    fetchedAt: 0,
  };
}

function writePayload(destDir: string) {
  writeFileSync(join(destDir, "manifest.json"), '{"name":"marketplace"}', "utf8");
  writeFileSync(join(destDir, "index.js"), "console.log(1)", "utf8");
}

test("github 302 redirect to objects.githubusercontent.com succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-redir-ok-"));
  try {
    const appData = join(root, "Roaming");
    const zip = makeZip([
      { name: "manifest.json", content: '{"name":"marketplace"}' },
      { name: "index.js", content: "console.log(1)" },
    ]);
    const seen: string[] = [];
    const runtime = realRuntime(appData, async () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      release: testRelease(zip),
      fetcher: (async (url: string) => {
        seen.push(url);
        if (url.startsWith("https://github.com/")) {
          return redirectResponse("https://objects.githubusercontent.com/abc123/marketplace.zip");
        }
        assert.equal(url, "https://objects.githubusercontent.com/abc123/marketplace.zip");
        return zipResponse(zip);
      }) as typeof fetch,
      extractZip: async (_zipPath, destDir) => { writePayload(destDir); },
    });
    assert.equal(result.status, "installed", (result as { error?: string }).error);
    assert.deepEqual(seen, [
      "https://github.com/spicetify/marketplace/releases/download/v9.9.9/marketplace.zip",
      "https://objects.githubusercontent.com/abc123/marketplace.zip",
    ]);
    assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace", "manifest.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redirect to an untrusted host or http fails closed", async () => {
  for (const location of ["https://evil.example/a.zip", "http://objects.githubusercontent.com/a.zip"]) {
    const root = mkdtempSync(join(tmpdir(), "mp-redir-bad-"));
    try {
      const appData = join(root, "Roaming");
      const zip = makeZip([
        { name: "manifest.json", content: "{}" },
        { name: "index.js", content: "x" },
      ]);
      let fetches = 0;
      const runtime = realRuntime(appData, async () => { throw new Error("must not run after refused redirect"); });
      const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
        release: testRelease(zip),
        fetcher: (async () => {
          fetches += 1;
          return redirectResponse(location);
        }) as typeof fetch,
        extractZip: async () => { throw new Error("must not extract after refused redirect"); },
      });
      assert.equal(result.status, "failed", location);
      assert.match((result as { error: string }).error, /E_DOWNLOAD_REDIRECT|not trusted|only https/i, location);
      assert.equal(fetches, 1, "no follow-up fetch after refusal");
      assert.equal(runtime.runCalls.length, 0);
      assert.equal(existsSync(join(appData, "spicetify", "CustomApps", "marketplace")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("redirect loop beyond 3 hops fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-redir-loop-"));
  try {
    const appData = join(root, "Roaming");
    const zip = makeZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "x" },
    ]);
    let fetches = 0;
    const runtime = realRuntime(appData, async () => { throw new Error("must not run in a loop"); });
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      release: testRelease(zip),
      fetcher: (async (url: string) => {
        fetches += 1;
        return redirectResponse(`https://github.com/spicetify/marketplace/loophop${fetches}`);
      }) as typeof fetch,
      extractZip: async () => { throw new Error("must not extract in a loop"); },
    });
    assert.equal(result.status, "failed");
    assert.match((result as { error: string }).error, /redirect limit|loop|E_DOWNLOAD_REDIRECT/i);
    assert.equal(fetches, 4, "initial fetch plus exactly 3 followed hops");
    assert.equal(runtime.runCalls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("network failure preserves error.cause detail", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-cause-"));
  try {
    const appData = join(root, "Roaming");
    const zip = makeZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "x" },
    ]);
    const runtime = realRuntime(appData, async () => { throw new Error("must not run after network failure"); });
    const failure = new Error("fetch failed");
    (failure as { cause?: unknown }).cause = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      release: testRelease(zip),
      fetcher: (async () => { throw failure; }) as typeof fetch,
    });
    assert.equal(result.status, "failed");
    const error = (result as { error: string }).error;
    assert.match(error, /ENOTFOUND/, "cause code is preserved");
    assert.match(error, /getaddrinfo/, "cause message is preserved");
    assert.equal(runtime.runCalls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only spicetify config custom_apps marketplace is ever run", async () => {
  const root = mkdtempSync(join(tmpdir(), "mp-onlyreg-"));
  try {
    const appData = join(root, "Roaming");
    const runtime = realRuntime(appData, async () => ({ code: 0, stdout: "", stderr: "" }));
    const zip = makeZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "x" },
    ]);
    const result = await installMarketplace(runtime, { path: "C:\\sp.exe", configPath: null } as never, {
      zipBytes: zip,
      release: testRelease(zip),
      extractZip: async (_zipPath, destDir) => { writePayload(destDir); },
    });
    assert.equal(result.status, "installed", (result as { error?: string }).error);
    const spCalls = runtime.runCalls
      .filter((c) => c.file === "C:\\sp.exe")
      .map((c) => `${c.file} ${c.args.join(" ")}`);
    assert.deepEqual(spCalls, ["C:\\sp.exe config custom_apps marketplace"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
