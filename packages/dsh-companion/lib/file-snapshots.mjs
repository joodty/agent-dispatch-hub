// Bounded before/after metadata snapshots and diffs for declared write roots
// (docs/SAFETY-V0.3.md). Native target filesystem only.
//
// A snapshot stores only kind/size/SHA-256/mode for regular files, plus root
// state. File contents never enter the record. Symlinks are never followed and
// count as exclusions.
//
// Exclusion rules are fixed and deterministic:
//   vcs            directories .git, .svn, .hg
//   dependencies   directory node_modules
//   build-output   directories dist, build, out, coverage
//   cache          directories .cache, .turbo, .next, .nuxt, .svelte-kit,
//                  .angular, .parcel-cache, .vite, .pnpm-store, __pycache__,
//                  .pytest_cache, .mypy_cache, .ruff_cache, .tox, .nox,
//                  .venv, venv, .gradle
//   credentials    directories .ssh, .aws, .gnupg, .docker, .kube,
//                  .password-store, .agent-dispatch-hub, .dsh,
//                  .codex-dsh-bridge; files .env and .env.* (except .env.example,
//                  .env.sample, .env.template, .env.dist), .envrc, .netrc,
//                  _netrc, .npmrc, .pypirc, .git-credentials, credentials(.json),
//                  connection.json, secrets.{json,yaml,yml,toml}, id_rsa,
//                  id_dsa, id_ecdsa, id_ed25519, and files ending in .pem, .key,
//                  .p12, .pfx, .jks, .kdbx, .keystore, .ppk, .token, .secret,
//                  .credentials
//   symlink        a symlink or Windows reparse point, skipped without following
//   special-file   anything that is neither a regular file nor a directory
// `excluded.rules` records the sorted ids of rules that actually matched.
//
// Windows limitation: Node exposes no O_NOFOLLOW/OPEN_REPARSE_POINT open mode.
// We check lstat before open, compare fstat identity after open, re-lstat the
// path, re-check realpath containment, and compare metadata after hashing.
// That turns most races into explicit unstable-scan/root-escape errors, but
// path-based open is not atomic, so an adversarial replacement inside the open
// window cannot be excluded with certainty on Windows.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 2500,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxMillis: 20_000,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const READ_CHUNK = 64 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SHA256 = /^[0-9a-f]{64}$/;

const DIR_EXCLUSION_RULES = Object.freeze([
  Object.freeze({
    rule: "vcs",
    names: Object.freeze([".git", ".svn", ".hg"]),
  }),
  Object.freeze({
    rule: "dependencies",
    names: Object.freeze(["node_modules"]),
  }),
  Object.freeze({
    rule: "build-output",
    names: Object.freeze(["dist", "build", "out", "coverage"]),
  }),
  Object.freeze({
    rule: "cache",
    names: Object.freeze([
      ".cache",
      ".turbo",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".angular",
      ".parcel-cache",
      ".vite",
      ".pnpm-store",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".tox",
      ".nox",
      ".venv",
      "venv",
      ".gradle",
    ]),
  }),
  Object.freeze({
    rule: "credentials",
    names: Object.freeze([
      ".ssh",
      ".aws",
      ".gnupg",
      ".docker",
      ".kube",
      ".password-store",
      ".agent-dispatch-hub",
      ".dsh",
      ".codex-dsh-bridge",
    ]),
  }),
]);

const SAFE_ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
]);
const CREDENTIAL_EXACT = new Set([
  ".envrc",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "connection.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "secrets.toml",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const CREDENTIAL_SUFFIXES = Object.freeze([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".kdbx",
  ".keystore",
  ".ppk",
  ".token",
  ".secret",
  ".credentials",
]);

const DIR_RULE_LOOKUP = new Map();
for (const entry of DIR_EXCLUSION_RULES)
  for (const name of entry.names) DIR_RULE_LOOKUP.set(name, entry.rule);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function invalidArgument(message) {
  throw new SnapshotError("invalid-arguments", message);
}

/** Snapshot/diff failures are explicit; a partial scan is never returned. */
export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameIdentity(left, right) {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0n || right.ino !== 0n) return left.ino === right.ino;
  // Some platforms/filesystems do not expose a stable inode number.
  return left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
}

function isWithin(candidate, root) {
  if (process.platform === "win32") {
    const child = path.resolve(candidate).toLowerCase();
    const parent = path.resolve(root).toLowerCase();
    const relative = path.win32.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith("..\\") &&
        !path.win32.isAbsolute(relative))
    );
  }
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function sameRecordedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function dirExclusionRule(name) {
  return DIR_RULE_LOOKUP.get(name.toLowerCase()) ?? null;
}

function fileExclusionRule(name) {
  const lower = name.toLowerCase();
  if (lower === ".env") return "credentials";
  if (lower.startsWith(".env.") && !SAFE_ENV_TEMPLATES.has(lower))
    return "credentials";
  if (CREDENTIAL_EXACT.has(lower)) return "credentials";
  if (CREDENTIAL_SUFFIXES.some((suffix) => lower.endsWith(suffix)))
    return "credentials";
  return null;
}

export function normalizeSnapshotLimits(limits) {
  if (limits === undefined) return { ...DEFAULT_LIMITS };
  if (!isPlainObject(limits)) invalidArgument("limits must be a plain object");
  for (const key of Object.keys(limits))
    if (!LIMIT_KEYS.includes(key))
      invalidArgument(`limits has unknown field "${key}"`);
  const normalized = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!Object.hasOwn(limits, key)) continue;
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 0)
      invalidArgument(`limits.${key} must be a non-negative safe integer`);
    normalized[key] = value;
  }
  return normalized;
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0)
    invalidArgument("roots must be a non-empty array");
  const seen = new Set();
  return roots.map((root, index) => {
    if (!isPlainObject(root))
      invalidArgument(`roots[${index}] must be a plain object`);
    for (const key of Object.keys(root))
      if (key !== "id" && key !== "path")
        invalidArgument(`roots[${index}] has unknown field "${key}"`);
    const id = root.id;
    if (!nonEmptyString(id))
      invalidArgument(`roots[${index}].id must be a non-empty string`);
    if (id !== id.trim())
      invalidArgument(`roots[${index}].id must not have surrounding spaces`);
    if (seen.has(id)) invalidArgument(`duplicate root id "${id}"`);
    seen.add(id);
    const rootPath = root.path;
    if (!nonEmptyString(rootPath))
      invalidArgument(`roots[${index}].path must be a non-empty string`);
    if (!path.isAbsolute(rootPath))
      invalidArgument(`roots[${index}].path must be absolute`);
    return { id, path: path.normalize(rootPath) };
  });
}

function checkBound(state) {
  if (state.signal?.aborted)
    throw new SnapshotError("aborted", "snapshot aborted by caller");
  if (Date.now() >= state.deadline)
    throw new SnapshotError(
      "limit-time",
      `snapshot exceeded its ${state.limits.maxMillis} ms time limit`,
    );
}

function markExcluded(state, rule) {
  state.excluded.count += 1;
  state.excluded.rules.add(rule);
}

function createFileRecord(rootId, relativePath, info, sha256) {
  return {
    root: rootId,
    path: relativePath,
    kind: "file",
    size: Number(info.size),
    sha256,
    mode: Number(info.mode & 0o7777n),
  };
}

async function hashFile(filePath, root, state, preInfo) {
  const size = Number(preInfo.size);
  if (size > state.limits.maxFileBytes)
    throw new SnapshotError(
      "limit-file-bytes",
      `file "${root.id}:${filePath}" exceeds the ${state.limits.maxFileBytes}-byte per-file limit`,
    );
  if (state.totalBytes + size > state.limits.maxTotalBytes)
    throw new SnapshotError(
      "limit-total-bytes",
      `snapshot exceeds the ${state.limits.maxTotalBytes}-byte total content limit`,
    );
  if (state.files.length >= state.limits.maxFiles)
    throw new SnapshotError(
      "limit-files",
      `snapshot exceeds the ${state.limits.maxFiles}-file limit`,
    );

  let resolved;
  try {
    resolved = await realpath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      throw new SnapshotError(
        "unstable-scan",
        `file "${root.id}:${filePath}" disappeared during the scan`,
      );
    throw new SnapshotError(
      "scan-failed",
      `file "${root.id}:${filePath}" could not be resolved`,
    );
  }
  if (!isWithin(resolved, state.rootReal))
    throw new SnapshotError(
      "root-escape",
      `file "${root.id}:${filePath}" resolves outside the declared root`,
    );
  const resolvedInfo = await lstat(resolved, { bigint: true });
  if (!resolvedInfo.isFile() || !sameIdentity(resolvedInfo, preInfo))
    throw new SnapshotError(
      "unstable-scan",
      `file "${root.id}:${filePath}" changed before it was opened`,
    );

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (
      error?.code === "ENOENT" ||
      error?.code === "ENOTDIR" ||
      error?.code === "ELOOP"
    )
      throw new SnapshotError(
        "unstable-scan",
        `file "${root.id}:${filePath}" changed before it was opened`,
      );
    throw new SnapshotError(
      "scan-failed",
      `file "${root.id}:${filePath}" could not be opened`,
    );
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !sameIdentity(opened, preInfo) ||
      opened.size !== preInfo.size ||
      opened.mtimeNs !== preInfo.mtimeNs ||
      opened.ctimeNs !== preInfo.ctimeNs
    )
      throw new SnapshotError(
        "unstable-scan",
        `file "${root.id}:${filePath}" changed while it was opened`,
      );
    const atPath = await lstat(filePath, { bigint: true });
    if (!sameIdentity(atPath, opened))
      throw new SnapshotError(
        "unstable-scan",
        `file "${root.id}:${filePath}" was replaced during the scan`,
      );

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let hashed = 0;
    for (;;) {
      checkBound(state);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, hashed);
      if (bytesRead === 0) break;
      hashed += bytesRead;
      if (hashed > state.limits.maxFileBytes)
        throw new SnapshotError(
          "limit-file-bytes",
          `file "${root.id}:${filePath}" exceeds the ${state.limits.maxFileBytes}-byte per-file limit`,
        );
      if (state.totalBytes + hashed > state.limits.maxTotalBytes)
        throw new SnapshotError(
          "limit-total-bytes",
          `snapshot exceeds the ${state.limits.maxTotalBytes}-byte total content limit`,
        );
      digest.update(buffer.subarray(0, bytesRead));
    }

    const finished = await handle.stat({ bigint: true });
    if (
      BigInt(hashed) !== opened.size ||
      finished.size !== opened.size ||
      finished.mtimeNs !== opened.mtimeNs ||
      finished.ctimeNs !== opened.ctimeNs
    )
      throw new SnapshotError(
        "unstable-scan",
        `file "${root.id}:${filePath}" changed while it was read`,
      );
    const finalAtPath = await lstat(filePath, { bigint: true });
    if (
      !sameIdentity(finalAtPath, opened) ||
      finalAtPath.size !== opened.size ||
      finalAtPath.mtimeNs !== opened.mtimeNs
    )
      throw new SnapshotError(
        "unstable-scan",
        `file "${root.id}:${filePath}" was replaced after it was read`,
      );

    state.totalBytes += hashed;
    state.files.push(
      createFileRecord(
        root.id,
        state.relativePath,
        opened,
        digest.digest("hex"),
      ),
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

async function scanDirectory(dirPath, relativeDir, root, state, preInfo) {
  checkBound(state);
  let resolved;
  try {
    resolved = await realpath(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      throw new SnapshotError(
        "unstable-scan",
        `directory "${root.id}:${relativeDir || "."}" disappeared during the scan`,
      );
    throw new SnapshotError(
      "scan-failed",
      `directory "${root.id}:${relativeDir || "."}" could not be resolved`,
    );
  }
  if (!isWithin(resolved, state.rootReal))
    throw new SnapshotError(
      "root-escape",
      `directory "${root.id}:${relativeDir || "."}" resolves outside the declared root`,
    );
  const resolvedInfo = await lstat(resolved, { bigint: true });
  if (!resolvedInfo.isDirectory() || !sameIdentity(resolvedInfo, preInfo))
    throw new SnapshotError(
      "unstable-scan",
      `directory "${root.id}:${relativeDir || "."}" changed before it was read`,
    );

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      throw new SnapshotError(
        "unstable-scan",
        `directory "${root.id}:${relativeDir || "."}" disappeared during the scan`,
      );
    throw new SnapshotError(
      "scan-failed",
      `directory "${root.id}:${relativeDir || "."}" could not be listed`,
    );
  }
  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    checkBound(state);
    const childRelative = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    const childPath = path.join(dirPath, entry.name);
    let info;
    try {
      info = await lstat(childPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
        throw new SnapshotError(
          "unstable-scan",
          `entry "${root.id}:${childRelative}" disappeared during the scan`,
        );
      throw new SnapshotError(
        "scan-failed",
        `entry "${root.id}:${childRelative}" could not be inspected`,
      );
    }

    if (info.isSymbolicLink()) {
      markExcluded(state, "symlink");
      continue;
    }
    if (info.isDirectory()) {
      const rule = dirExclusionRule(entry.name);
      if (rule) {
        markExcluded(state, rule);
        continue;
      }
      await scanDirectory(childPath, childRelative, root, state, info);
      continue;
    }
    if (!info.isFile()) {
      markExcluded(state, "special-file");
      continue;
    }
    const rule = fileExclusionRule(entry.name);
    if (rule) {
      markExcluded(state, rule);
      continue;
    }
    state.relativePath = childRelative;
    await hashFile(childPath, root, state, info);
  }

  checkBound(state);
  const after = await lstat(dirPath, { bigint: true });
  if (
    !after.isDirectory() ||
    !sameIdentity(after, preInfo) ||
    after.mtimeNs !== preInfo.mtimeNs ||
    after.ctimeNs !== preInfo.ctimeNs
  )
    throw new SnapshotError(
      "unstable-scan",
      `directory "${root.id}:${relativeDir || "."}" changed during the scan`,
    );
}

async function captureRoot(root, state) {
  checkBound(state);
  let info;
  try {
    info = await lstat(root.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (state.allowMissingRoots) return "missing";
      throw new SnapshotError(
        "root-missing",
        `declared root "${root.id}" does not exist`,
      );
    }
    if (error?.code === "ENOTDIR")
      throw new SnapshotError(
        "root-not-directory",
        `declared root "${root.id}" is not a directory`,
      );
    throw new SnapshotError(
      "root-unreadable",
      `declared root "${root.id}" could not be inspected`,
    );
  }
  if (info.isSymbolicLink())
    throw new SnapshotError(
      "root-symlink",
      `declared root "${root.id}" is a symlink and is never followed`,
    );
  if (!info.isDirectory())
    throw new SnapshotError(
      "root-not-directory",
      `declared root "${root.id}" is not a directory`,
    );

  try {
    state.rootReal = await realpath(root.path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      throw new SnapshotError(
        "unstable-scan",
        `declared root "${root.id}" disappeared before it was read`,
      );
    throw new SnapshotError(
      "root-unreadable",
      `declared root "${root.id}" could not be resolved`,
    );
  }
  const realInfo = await stat(state.rootReal, { bigint: true });
  if (!sameRecordedPath(state.rootReal, root.path))
    throw new SnapshotError(
      "root-escape",
      "snapshot roots must remain canonical target directories",
    );
  if (!realInfo.isDirectory() || !sameIdentity(realInfo, info))
    throw new SnapshotError(
      "unstable-scan",
      `declared root "${root.id}" changed before it was read`,
    );

  await scanDirectory(root.path, "", root, state, info);

  let after;
  try {
    after = await lstat(root.path, { bigint: true });
  } catch {
    throw new SnapshotError(
      "unstable-scan",
      `declared root "${root.id}" changed after the scan`,
    );
  }
  if (!after.isDirectory() || !sameIdentity(after, info))
    throw new SnapshotError(
      "unstable-scan",
      `declared root "${root.id}" changed after the scan`,
    );
  return "present";
}

/**
 * Capture bounded metadata for declared roots on the native target filesystem.
 *
 * `limits` may set maxFiles, maxFileBytes, maxTotalBytes and maxMillis; omitted
 * values use the safety defaults (2500 / 2 MiB / 32 MiB / 20000 ms). Missing
 * roots fail unless `allowMissingRoots` is true (intended only for the
 * after-snapshot, where the root may have been deleted). An exceeded limit,
 * aborted signal, changing tree or unreadable path throws SnapshotError;
 * a partial snapshot is never returned.
 */
export async function captureSnapshot({
  roots,
  limits,
  allowMissingRoots = false,
  signal,
} = {}) {
  const checkedLimits = normalizeSnapshotLimits(limits);
  const checkedRoots = normalizeRoots(roots);
  if (typeof allowMissingRoots !== "boolean")
    invalidArgument("allowMissingRoots must be an explicit boolean");
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean")
  )
    invalidArgument("signal must be an AbortSignal-like object");

  const state = {
    limits: checkedLimits,
    allowMissingRoots,
    signal,
    deadline: Date.now() + checkedLimits.maxMillis,
    rootReal: null,
    relativePath: "",
    files: [],
    totalBytes: 0,
    excluded: { count: 0, rules: new Set() },
  };

  const rootRecords = [];
  for (const root of checkedRoots) {
    const rootState = await captureRoot(root, state);
    rootRecords.push({ id: root.id, path: root.path, state: rootState });
  }

  const rootOrder = new Map(
    checkedRoots.map((root, index) => [root.id, index]),
  );
  state.files.sort((left, right) => {
    const byRoot = rootOrder.get(left.root) - rootOrder.get(right.root);
    return byRoot !== 0 ? byRoot : compareText(left.path, right.path);
  });

  return {
    version: SNAPSHOT_VERSION,
    roots: rootRecords,
    files: state.files,
    excluded: {
      count: state.excluded.count,
      rules: [...state.excluded.rules].sort(compareText),
    },
    limits: checkedLimits,
  };
}

function invalidSnapshot(message) {
  throw new SnapshotError("invalid-snapshot", message);
}

function validateSnapshot(snapshot, label) {
  if (!isPlainObject(snapshot)) invalidSnapshot(`${label} must be an object`);
  if (snapshot.version !== SNAPSHOT_VERSION)
    invalidSnapshot(`${label}.version must be ${SNAPSHOT_VERSION}`);
  if (!Array.isArray(snapshot.roots))
    invalidSnapshot(`${label}.roots must be an array`);
  if (!Array.isArray(snapshot.files))
    invalidSnapshot(`${label}.files must be an array`);

  const roots = new Map();
  snapshot.roots.forEach((root, index) => {
    if (!isPlainObject(root))
      invalidSnapshot(`${label}.roots[${index}] must be an object`);
    if (!nonEmptyString(root.id))
      invalidSnapshot(`${label}.roots[${index}].id is invalid`);
    if (!nonEmptyString(root.path))
      invalidSnapshot(`${label}.roots[${index}].path is invalid`);
    if (root.state !== "present" && root.state !== "missing")
      invalidSnapshot(`${label}.roots[${index}].state is invalid`);
    if (roots.has(root.id))
      invalidSnapshot(`${label} has duplicate root id "${root.id}"`);
    roots.set(root.id, root);
  });

  const seenFiles = new Set();
  snapshot.files.forEach((file, index) => {
    if (!isPlainObject(file))
      invalidSnapshot(`${label}.files[${index}] must be an object`);
    if (!roots.has(file.root))
      invalidSnapshot(`${label}.files[${index}].root is unknown`);
    if (!nonEmptyString(file.path) || file.path.includes("\\"))
      invalidSnapshot(`${label}.files[${index}].path is invalid`);
    const segments = file.path.split("/");
    if (
      file.path.startsWith("/") ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    )
      invalidSnapshot(`${label}.files[${index}].path is not root-relative`);
    if (!nonEmptyString(file.kind))
      invalidSnapshot(`${label}.files[${index}].kind is invalid`);
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      invalidSnapshot(`${label}.files[${index}].size is invalid`);
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256))
      invalidSnapshot(`${label}.files[${index}].sha256 is invalid`);
    if (!Number.isSafeInteger(file.mode) || file.mode < 0)
      invalidSnapshot(`${label}.files[${index}].mode is invalid`);
    const key = `${file.root}\u0000${file.path}`;
    if (seenFiles.has(key))
      invalidSnapshot(`${label} has duplicate file "${key}"`);
    seenFiles.add(key);
  });

  for (const file of snapshot.files) {
    if (roots.get(file.root).state !== "present")
      invalidSnapshot(
        `${label} records file "${file.path}" under a missing root`,
      );
  }
  return { roots, files: snapshot.files };
}

function metadataOf(file) {
  return {
    root: file.root,
    path: file.path,
    kind: file.kind,
    size: file.size,
    sha256: file.sha256,
    mode: file.mode,
  };
}

function metadataEqual(left, right) {
  return (
    left.kind === right.kind &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode
  );
}

/**
 * Deterministic add/modify/delete diff between two snapshots of the same roots.
 * Every change carries the before/after metadata (null when the file did not
 * exist on that side); no content is returned.
 */
export function diffSnapshots(before, after) {
  const checkedBefore = validateSnapshot(before, "before");
  const checkedAfter = validateSnapshot(after, "after");

  if (checkedBefore.roots.size !== checkedAfter.roots.size)
    invalidSnapshot("before and after snapshots have different roots");
  for (const [id, root] of checkedBefore.roots) {
    const other = checkedAfter.roots.get(id);
    if (!other) invalidSnapshot(`after snapshot is missing root "${id}"`);
    if (!sameRecordedPath(root.path, other.path))
      invalidSnapshot(`root "${id}" changed path between snapshots`);
  }

  const filesByRoot = (files) => {
    const map = new Map();
    for (const file of files) {
      let rootFiles = map.get(file.root);
      if (!rootFiles) {
        rootFiles = new Map();
        map.set(file.root, rootFiles);
      }
      rootFiles.set(file.path, file);
    }
    return map;
  };
  const beforeFiles = filesByRoot(checkedBefore.files);
  const afterFiles = filesByRoot(checkedAfter.files);
  const changes = [];

  for (const root of before.roots) {
    const oldRoot = beforeFiles.get(root.id) ?? new Map();
    const newRoot = afterFiles.get(root.id) ?? new Map();
    const paths = [...new Set([...oldRoot.keys(), ...newRoot.keys()])].sort(
      compareText,
    );
    for (const relativePath of paths) {
      const oldFile = oldRoot.get(relativePath) ?? null;
      const newFile = newRoot.get(relativePath) ?? null;
      if (!oldFile) {
        changes.push({
          root: root.id,
          path: relativePath,
          change: "added",
          before: null,
          after: metadataOf(newFile),
        });
        continue;
      }
      if (!newFile) {
        changes.push({
          root: root.id,
          path: relativePath,
          change: "deleted",
          before: metadataOf(oldFile),
          after: null,
        });
        continue;
      }
      if (!metadataEqual(oldFile, newFile)) {
        changes.push({
          root: root.id,
          path: relativePath,
          change: "modified",
          before: metadataOf(oldFile),
          after: metadataOf(newFile),
        });
      }
    }
  }
  return changes;
}
