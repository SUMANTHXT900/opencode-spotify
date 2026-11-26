#!/usr/bin/env node
/**
 * verify-package-lib.mjs — pure, testable helpers for scripts/verify-package.mjs.
 *
 * Ownership: WP-A. Sole production helper beside verify-package.mjs.
 *
 * Exports (stable for WP-B regression tests):
 * - parseVerifierArgs(argv) -> { tarball, keepDir, logsDir }
 * - indexTarball(tgzBytes) -> { entries, files } (gunzip + validate once)
 * - digests(bytes) -> { sha256, sha512, integrity }
 * - retainArtifact(keepDir, fileName, verifiedBytes) -> retention record
 * - sanitizeMessage(text) -> redacted single-line diagnostic
 *
 * Retention semantics (no overwrite of prior QA artifacts):
 * - The retained file is the exact verified byte snapshot, never re-packed.
 * - If <keepDir>/<fileName> already exists and is byte-identical to the
 *   verified bytes, it is re-used (sidecars are verified/created, the .tgz is
 *   never rewritten).
 * - If it already exists with different bytes, this fails closed with a
 *   conflict error and never overwrites the prior artifact.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KNOWN_FLAGS = new Set(["--tarball", "--keep-dir", "--logs-dir"]);

/**
 * Strict CLI argument parsing. Only `--tarball PATH`, `--keep-dir DIR` and
 * `--logs-dir DIR` are accepted; everything else (unknown flags, `--x=y`
 * forms, positionals, duplicates, missing values) throws.
 */
export function parseVerifierArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const out = { tarball: null, keepDir: null, logsDir: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`verify-package: unknown option: ${arg}`);
    }
    if (seen.has(arg)) {
      throw new Error(`verify-package: duplicate option: ${arg}`);
    }
    seen.add(arg);
    const value = args[i + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`verify-package: ${arg} requires a value`);
    }
    i++;
    if (arg === "--tarball") out.tarball = value;
    else if (arg === "--keep-dir") out.keepDir = value;
    else out.logsDir = value;
  }
  return out;
}

/** Independent SHA-256 + SHA-512 digests of the exact verified bytes. */
export function digests(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const sha512base64 = createHash("sha512").update(buf).digest("base64");
  return { sha256, sha512: sha512base64, integrity: `sha512-${sha512base64}` };
}

/** Verify both adjacent digests, or accept a standalone archive without either. */
export function verifyArtifactSidecars(fileName, bytes, shaText, integrityText) {
  if (shaText === null && integrityText === null) return false;
  if (shaText === null || integrityText === null) throw new Error("prebuilt sidecar set is incomplete");
  const { sha256, integrity } = digests(bytes);
  if (shaText.trimEnd() !== `${sha256}  ${fileName}` || integrityText.trimEnd() !== integrity) {
    throw new Error("prebuilt sidecar mismatch (refusing to install before npm)");
  }
  return true;
}

function parseOctal(text, field) {
  const clean = text.replace(/\0.*$/s, "").trim();
  if (clean === "") return 0;
  if (!/^[0-7]+$/.test(clean)) {
    throw new Error(`verify-package: invalid octal in tar header ${field}: ${JSON.stringify(clean.slice(0, 32))}`);
  }
  const value = Number.parseInt(clean, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`verify-package: out-of-range tar size in ${field}`);
  }
  return value;
}

function headerChecksum(header) {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  return sum;
}

function safeName(name, directory) {
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new Error("verify-package: absolute tar entry rejected");
  }
  const canonical = directory ? name.replace(/\/$/, "") : name;
  const parts = canonical.split("/");
  if (parts.includes("..")) throw new Error("verify-package: parent-escape tar entry rejected");
  if (parts[0] !== "package" || (!directory && parts.length < 2) || parts.some((part) =>
    !/^[A-Za-z0-9._-]+$/.test(part) || part.endsWith(".") ||
    /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part))) {
    throw new Error("verify-package: non-canonical or unsafe tar entry name");
  }
  return canonical;
}

/**
 * Decompress exactly once and build a validated ustar index.
 * Returns { entries: [{name,size,type}], files: Map<name, Buffer> }.
 * Throws (fail closed) on truncated data, bad checksums, or unsafe names.
 */
export function indexTarball(tgzBytes) {
  const buf = Buffer.isBuffer(tgzBytes) ? tgzBytes : Buffer.from(tgzBytes);
  let raw;
  try {
    raw = gunzipSync(buf, { maxOutputLength: 32 * 1024 * 1024 });
  } catch {
    throw new Error("verify-package: tarball is not valid gzip");
  }
  const entries = [];
  const files = new Map();
  const seen = new Set();
  let offset = 0;
  let endHits = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      endHits++;
      offset += 512;
      if (endHits >= 2) break;
      continue;
    }
    if (endHits !== 0) throw new Error("verify-package: nonzero entry after tar terminator");
    const magic = header.subarray(257, 262).toString("utf8");
    if (magic !== "ustar") throw new Error("verify-package: non-ustar tar entry (refusing to guess layout)");
    const stored = parseOctal(header.subarray(148, 156).toString("utf8"), "chksum");
    if (headerChecksum(header) !== stored) {
      throw new Error("verify-package: tar header checksum mismatch (archive may be corrupt)");
    }
    // ustar prefix handling: name(0:100) + prefix(345:500).
    const base = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseOctal(header.subarray(124, 136).toString("utf8"), "size");
    const typeFlag = String.fromCharCode(header[156]);
    if (!/^[05]$/.test(typeFlag) && typeFlag !== "\0") {
      throw new Error("verify-package: unsupported tar entry type");
    }
    const fullName = safeName(prefix ? `${prefix}/${base}` : base, typeFlag === "5");
    const key = fullName.toLowerCase();
    if (seen.has(key)) throw new Error("verify-package: duplicate tar entry rejected");
    seen.add(key);
    if (typeFlag === "5" && size !== 0) throw new Error("verify-package: directory has tar payload");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > raw.length) throw new Error(`verify-package: truncated tar entry ${fullName.slice(0, 80)}`);
    entries.push({ name: fullName, size, type: typeFlag === "\0" ? "0" : typeFlag });
    if (typeFlag !== "5") files.set(fullName, raw.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (entries.length > 20000) throw new Error("verify-package: tarball has too many entries");
  }
  if (entries.length === 0) throw new Error("verify-package: tarball index is empty");
  if (endHits !== 2 || raw.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error("verify-package: tar end marker missing or followed by data");
  }
  return { entries, files };
}

/**
 * Retain the exact verified bytes under keepDir/fileName without ever
 * overwriting a prior differing artifact. Byte-identical re-use is allowed;
 * conflicts fail closed. Sidecars (.sha256, .integrity) are verified when
 * present and created when absent; mismatched sidecars fail closed.
 */
export function retainArtifact(keepDir, fileName, verifiedBytes) {
  if (typeof keepDir !== "string" || keepDir.length === 0) {
    throw new Error("verify-package: retain requires a keep directory");
  }
  if (typeof fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/.test(fileName)) {
    throw new Error("verify-package: retain requires a plain .tgz file name");
  }
  const buf = Buffer.isBuffer(verifiedBytes) ? verifiedBytes : Buffer.from(verifiedBytes);
  const { sha256, integrity } = digests(buf);
  mkdirSync(keepDir, { recursive: true });
  const dest = join(keepDir, fileName);
  let reused = false;
  try {
    writeFileSync(dest, buf, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readFileSync(dest);
    if (existing.length !== buf.length || !timingSafeEqual(existing, buf)) {
      throw new Error(
        `verify-package: retain conflict — ${dest} already exists with different bytes; refusing to overwrite prior QA artifact`,
      );
    }
    reused = true;
  }
  const shaSidecar = `${dest}.sha256`;
  const intSidecar = `${dest}.integrity`;
  const expectedSha = `${sha256}  ${fileName}\n`;
  const expectedInt = `${integrity}\n`;
  for (const [path, expected] of [[shaSidecar, expectedSha], [intSidecar, expectedInt]]) {
    try {
      writeFileSync(path, expected, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readFileSync(path, "utf8");
      if (current !== expected) {
        throw new Error(`verify-package: retain conflict — sidecar ${path} differs; refusing to overwrite prior QA artifact`);
      }
    }
  }
  // Read-back: the retained bytes must hash identically.
  const kept = readFileSync(dest);
  const recheck = digests(kept);
  if (recheck.sha256 !== sha256 || recheck.integrity !== integrity) {
    throw new Error("verify-package: retained artifact failed read-back digest verification");
  }
  return { path: dest, sha256, integrity, reused };
}

/** Redact secret-like values and hex runs; report counts, never values. */
export function sanitizeMessage(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-hex]")
    .replace(/\b(secret|token|password|credential|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 400);
}
