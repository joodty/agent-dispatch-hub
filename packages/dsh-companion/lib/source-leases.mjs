import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  rename,
  unlink,
  rmdir,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { normalizeTargetPath, isWithin } from "./placement.mjs";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const RUN = new RegExp("^run-" + UUID + "$"),
  JOB = new RegExp("^job-" + UUID + "$"),
  SESSION = new RegExp("^session-" + UUID + "$"),
  REQUEST = new RegExp("^" + UUID + "$");
export class LeaseError extends Error {
  constructor(code) {
    super("Source lease rejected: " + code);
    this.name = "LeaseError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new LeaseError(code);
};
function owner(value) {
  if (
    !value ||
    !RUN.test(value.runId ?? "") ||
    !JOB.test(value.jobId ?? "") ||
    !SESSION.test(value.sessionId ?? "") ||
    !REQUEST.test(value.requestId ?? "") ||
    value.runId !== "run-" + value.requestId
  )
    fail("invalid-lease-owner");
  return Object.fromEntries(
    ["runId", "jobId", "sessionId", "requestId"].map((k) => [k, value[k]]),
  );
}
const sameOwner = (a, b) =>
  ["runId", "jobId", "sessionId", "requestId"].every((k) => a[k] === b[k]);

export class SourceLeaseStore {
  constructor({ directory, instanceId, pathStyle }) {
    if (
      !path.isAbsolute(directory ?? "") ||
      !["win32", "posix"].includes(pathStyle) ||
      typeof instanceId !== "string" ||
      !instanceId ||
      instanceId.length > 200
    )
      fail("invalid-lease-store");
    this.directory = directory;
    this.instanceId = instanceId;
    this.pathStyle = pathStyle;
    this.file = path.join(directory, "leases.json");
    this.mutex = path.join(directory, "transaction.lock");
  }
  roots(roots) {
    if (!Array.isArray(roots) || !roots.length || roots.length > 100)
      fail("invalid-lease-roots");
    const normalized = roots.map((root) => {
      let value;
      try {
        value = normalizeTargetPath(root, this.pathStyle);
      } catch {
        fail("invalid-lease-roots");
      }
      if (this.pathStyle === "win32") value = value.toLowerCase();
      return value;
    });
    return [...new Set(normalized)].sort();
  }
  async transaction(fn) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(this.directory)).isDirectory() ||
      (await lstat(this.directory)).isSymbolicLink()
    )
      fail("invalid-lease-store");
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      try {
        await mkdir(this.mutex, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await pause(50);
    }
    if (!acquired) fail("lease-store-busy");
    try {
      // The mutex is short-lived; a crashed transaction is never guessed stale.
      await writeFile(
        path.join(this.mutex, "owner.json"),
        JSON.stringify({ pid: process.pid }),
        { flag: "wx", mode: 0o600 },
      );
      return await fn();
    } finally {
      await unlink(path.join(this.mutex, "owner.json")).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      await rmdir(this.mutex);
    }
  }
  async read() {
    let data;
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink()) fail("invalid-lease-state");
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      fail("invalid-lease-state");
    }
    if (
      data.version !== 1 ||
      data.instanceId !== this.instanceId ||
      data.pathStyle !== this.pathStyle ||
      !Array.isArray(data.leases)
    )
      fail("invalid-lease-state");
    const ids = new Set();
    for (const row of data.leases) {
      owner(row);
      if (
        !["read", "write"].includes(row.mode) ||
        ids.has(row.runId) ||
        JSON.stringify(this.roots(row.roots)) !== JSON.stringify(row.roots)
      )
        fail("invalid-lease-state");
      ids.add(row.runId);
    }
    return data.leases;
  }
  async write(leases) {
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            version: 1,
            instanceId: this.instanceId,
            pathStyle: this.pathStyle,
            leases,
          }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } finally {
      await unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  acquire(args) {
    const identity = owner(args),
      roots = this.roots(args.roots),
      mode = args.mode;
    if (!["read", "write"].includes(mode)) fail("invalid-lease-mode");
    return this.transaction(async () => {
      const leases = await this.read(),
        existing = leases.find((l) => l.runId === identity.runId);
      if (existing) {
        if (
          !sameOwner(existing, identity) ||
          existing.mode !== mode ||
          JSON.stringify(existing.roots) !== JSON.stringify(roots)
        )
          fail("lease-owner-conflict");
        return structuredClone(existing);
      }
      const overlaps = (a, b) =>
        isWithin(a, b, this.pathStyle) || isWithin(b, a, this.pathStyle);
      if (
        leases.some(
          (l) =>
            (l.mode === "write" || mode === "write") &&
            l.roots.some((a) => roots.some((b) => overlaps(a, b))),
        )
      )
        fail("source-locked");
      const row = { ...identity, roots, mode };
      leases.push(row);
      await this.write(leases);
      return structuredClone(row);
    });
  }
  release(args) {
    const identity = owner(args);
    return this.transaction(async () => {
      const leases = await this.read(),
        existing = leases.find((l) => l.runId === identity.runId);
      if (!existing) return { released: false };
      if (!sameOwner(existing, identity)) fail("lease-owner-conflict");
      await this.write(leases.filter((l) => l.runId !== identity.runId));
      return { released: true };
    });
  }
  list() {
    return this.transaction(async () => structuredClone(await this.read()));
  }
}
