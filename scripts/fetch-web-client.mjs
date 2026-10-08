/*
 * Copyright 2026 ECSDevs
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Fetches the compiled Compose Multiplatform web client (Kotlin/Wasm) and
 * unpacks it into `public/app/`, so the browser client ships with the server
 * deployment instead of being committed to the repository.
 *
 * The client is built from the Messenger repository — which is the PARENT of
 * this one, so its Kotlin/Wasm toolchain is not available here. It is therefore
 * consumed as an artifact: the parent's release workflow attaches
 * `messenger-web-<tag>.zip` to each GitHub Release, and this script downloads
 * the newest one.
 *
 * Configuration (all optional):
 *   WEB_CLIENT_REPO      owner/name to download from  (default ECSDevs/Messenger)
 *   WEB_CLIENT_TAG       a specific release tag       (default: newest release)
 *   WEB_CLIENT_URL       explicit archive URL         (skips release lookup)
 *   WEB_CLIENT_REQUIRED  "1" makes a failure fatal    (default: warn and continue)
 *   WEB_CLIENT_VERSION   labels the unpacked build    (default: release tag)
 *   WEB_CLIENT_BASE_PATH mount path of the client     (default /app/)
 *
 * Run manually with `pnpm web:client` (add `--force` to re-download).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const TARGET_DIR = join(SERVER_ROOT, "public", "app");
const MARKER = join(TARGET_DIR, ".web-client-build.json");

const REPO = process.env.WEB_CLIENT_REPO ?? "ECSDevs/Messenger";
/** Release tag the parent repo's CI republishes on every push to main. */
const ROLLING_TAG = "web-client";
const FORCE = process.argv.includes("--force");
const REQUIRED = process.env.WEB_CLIENT_REQUIRED === "1";

const log = (message) => console.log(`[web-client] ${message}`);
const warn = (message) => console.warn(`[web-client] ${message}`);

/**
 * Aborts the build only when the operator asked for that. Returning normally
 * (rather than process.exit) lets pending sockets close on their own; exiting
 * mid-fetch trips a libuv assertion that reads like a crash in CI logs.
 */
function fail(message) {
  if (REQUIRED) throw new Error(message);
  warn(message);
  warn("continuing without the web client (set WEB_CLIENT_REQUIRED=1 to make this fatal)");
  return null;
}

async function main() {
  if (!FORCE && (await isUpToDate())) {
    log(`already up to date (${(await readMarker()).version})`);
    return;
  }

  const source = await resolveSource();
  if (!source) return;
  const { url, version } = source;
  log(`downloading ${url}`);
  const archive = await download(url);
  if (!archive) return;
  log(`unpacking ${(archive.length / 1024 / 1024).toFixed(1)} MiB into public/app`);

  await unpackInto(archive);
  await applyBasePath();

  // Written last: its presence is what proves a complete unpack.
  await writeFile(
    MARKER,
    `${JSON.stringify({ version, source: url, fetchedAt: new Date().toISOString() }, null, 2)}\n`
  );
  log(`done (${version})`);
}

/**
 * The client is mounted at a sub-path, but its page references its assets
 * RELATIVELY (`webApp.js`, `composeResources/...`). Next.js does not resolve a
 * directory index for `/app` (and normalizes `/app/` back to `/app`), so the
 * document URL has no trailing slash and every relative reference would climb
 * to the site root. A `<base>` tag pins them to the mount path instead.
 *
 * Only that one attribute is touched: nothing else in the artifact is altered,
 * and the dev server (which serves the client at `/`) keeps the untouched copy.
 */
async function applyBasePath() {
  const basePath = process.env.WEB_CLIENT_BASE_PATH ?? "/app/";
  const indexPath = join(TARGET_DIR, "index.html");
  const html = await readFile(indexPath, "utf8");

  if (/<base\s/i.test(html)) return;
  if (!html.includes("<head>")) return fail("index.html has no <head> to inject <base> into");

  const href = basePath.endsWith("/") ? basePath : `${basePath}/`;
  await writeFile(indexPath, html.replace("<head>", `<head>\n  <base href="${href}">`));
  log(`mounted at ${href}`);
}

async function readMarker() {
  try {
    return JSON.parse(await readFile(MARKER, "utf8"));
  } catch {
    return null;
  }
}

/** A complete unpack plus a matching version means there is nothing to do. */
async function isUpToDate() {
  const marker = await readMarker();
  if (!marker) return false;
  if (!existsSync(join(TARGET_DIR, "index.html")) || !existsSync(join(TARGET_DIR, "webApp.js"))) {
    return false;
  }
  const expected = process.env.WEB_CLIENT_TAG ?? process.env.WEB_CLIENT_VERSION;
  return !expected || expected === marker.version;
}

async function resolveSource() {
  if (process.env.WEB_CLIENT_URL) {
    return {
      url: process.env.WEB_CLIENT_URL,
      version: process.env.WEB_CLIENT_VERSION ?? "custom",
    };
  }

  // Prefer the dedicated rolling release tag. `/releases/latest` is NOT safe
  // here: it follows whichever release was published most recently, so the next
  // versioned tag release (which carries no web asset) would silently become
  // the source and break the client. The rolling tag is stable by construction.
  const attempts = process.env.WEB_CLIENT_TAG
    ? [process.env.WEB_CLIENT_TAG]
    : [ROLLING_TAG, null];

  const problems = [];
  for (const tag of attempts) {
    const releaseUrl = tag
      ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
      : `https://api.github.com/repos/${REPO}/releases/latest`;

    let release;
    try {
      release = await getJson(releaseUrl);
    } catch (error) {
      problems.push(`${releaseUrl}: ${error.message}`);
      continue;
    }

    const asset = (release.assets ?? []).find((candidate) =>
      /^messenger-web-.*\.zip$/.test(candidate.name)
    );
    if (asset) return { url: asset.browser_download_url, version: release.tag_name };

    problems.push(
      `${release.tag_name} has no messenger-web-*.zip ` +
        `(found: ${(release.assets ?? []).map((a) => a.name).join(", ") || "none"})`
    );
  }

  return fail(`no web client artifact found:\n  - ${problems.join("\n  - ")}`);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "messenger-server" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function download(url) {
  // A fresh clone or a public release needs no credentials; a private fork
  // can supply a token.
  const headers = { "user-agent": "messenger-server" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 1000);
    }
  }
  return fail(`download failed: ${lastError.message}`);
}

/** Replaces public/app's contents, keeping the committed .gitkeep. */
async function unpackInto(archive) {
  const entries = readZip(archive);
  if (entries.length === 0) fail("archive contains no files");

  for (const name of await listContents(TARGET_DIR)) {
    if (name === ".gitkeep") continue;
    await rm(join(TARGET_DIR, name), { recursive: true, force: true });
  }
  await mkdir(TARGET_DIR, { recursive: true });

  let written = 0;
  for (const entry of entries) {
    // Defend against an archive writing outside the target (zip-slip). The
    // release archive is built with `zip -r ... .`, so names may carry a "./".
    const clean = entry.name.replace(/^(\.\/)+/, "");
    const destination = resolve(TARGET_DIR, clean);
    const inside = relative(TARGET_DIR, destination);
    if (inside.startsWith("..") || inside.includes(`..${sep}`) || resolve(TARGET_DIR, inside) !== destination) {
      fail(`archive entry escapes the target directory: ${entry.name}`);
    }
    if (clean.endsWith("/")) {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
    written += 1;
  }
  log(`unpacked ${written} files`);
}

async function listContents(dir) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader
// ---------------------------------------------------------------------------
//
// Dependency-free on purpose: the release archive is a plain deflate ZIP and
// Node already ships the only primitive required (zlib.inflateRawSync). Adding
// an extraction package to a production dependency list for this would be
// disproportionate.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

/** Reads every entry (name + inflated bytes) out of a ZIP archive. */
function readZip(buffer) {
  const central = locateCentralDirectory(buffer);
  const entries = [];
  const seen = new Set();

  let offset = central.offset;
  for (let index = 0; index < central.count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      fail(`corrupt ZIP: bad central directory entry at ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    // ZIP64 sentinels: the real values live in the extra field.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      const extra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      const zip64 = readZip64Extra(extra);
      compressedSize = zip64.compressedSize ?? compressedSize;
      uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
      localOffset = zip64.localOffset ?? localOffset;
    }

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) {
      entries.push({ name, data: Buffer.alloc(0) });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    const data = extractEntry(buffer, { method, compressedSize, uncompressedSize, localOffset, name });
    entries.push({ name, data });
  }
  return entries;
}

function extractEntry(buffer, entry) {
  // The local header repeats the name/extra lengths, which can differ from the
  // central directory's, so the data offset must be computed from the local one.
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) {
    fail(`corrupt ZIP: bad local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    const inflated = inflateRawSync(raw);
    if (entry.uncompressedSize && inflated.length !== entry.uncompressedSize) {
      fail(
        `corrupt ZIP: ${entry.name} inflated to ${inflated.length} bytes, ` +
          `expected ${entry.uncompressedSize}`
      );
    }
    return inflated;
  }
  return fail(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

function locateCentralDirectory(buffer) {
  // The EOCD is at the end but may be followed by a comment, so scan backwards.
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;

    let count = buffer.readUInt16LE(offset + 10);
    let size = buffer.readUInt32LE(offset + 12);
    let directoryOffset = buffer.readUInt32LE(offset + 16);

    // ZIP64: the 32-bit fields are sentinels and the real ones live in the
    // ZIP64 EOCD the locator points at.
    if (count === 0xffff || size === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = offset - 20;
      if (locator >= 0 && buffer.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR) {
        const eocd64 = Number(buffer.readBigUInt64LE(locator + 8));
        if (buffer.readUInt32LE(eocd64) === ZIP64_EOCD) {
          count = Number(buffer.readBigUInt64LE(eocd64 + 32));
          size = Number(buffer.readBigUInt64LE(eocd64 + 40));
          directoryOffset = Number(buffer.readBigUInt64LE(eocd64 + 48));
        }
      }
    }
    return { count, size, offset: directoryOffset };
  }
  return fail("not a ZIP archive (no end-of-central-directory record)");
}

function readZip64Extra(extra) {
  // Header: id (2) + size (2) + [uncompressed, compressed, localOffset, disk] (8 each)
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    if (id === 0x0001) {
      let at = cursor + 4;
      const result = {};
      const take = () => {
        if (at + 8 > cursor + 4 + size) return undefined;
        const value = Number(extra.readBigUInt64LE(at));
        at += 8;
        return value;
      };
      result.uncompressedSize = take();
      result.compressedSize = take();
      result.localOffset = take();
      return result;
    }
    cursor += 4 + size;
  }
  return {};
}

main().catch((error) => fail(error.message));
