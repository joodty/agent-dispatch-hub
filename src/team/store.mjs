// Durable team inbox store.
// Integration target: src/team/store.mjs (imports use "../core/state.mjs").
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HubError, atomicJson } from "../core/state.mjs";

const MAX_STATE_BYTES = 5 * 1024 * 1024;

function emptyState() {
  return { version: 1, projects: {}, members: {}, messages: {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid() {
  return new HubError(
    "invalid-team-state",
    "The team state file is not a valid version 1 team state.",
  );
}

function validate(state) {
  if (!isPlainObject(state)) throw invalid();
  if (state.version !== 1) throw invalid();
  for (const key of ["projects", "members", "messages"])
    if (!isPlainObject(state[key])) throw invalid();
  return state;
}

export class TeamStore {
  constructor({ home }) {
    this.home = home;
    this.directory = join(home, "team");
    this.statePath = join(this.directory, "state.json");
    this.lockPath = join(this.directory, "state.lock");
  }

  // Lock-free consistent read: stat the path, then read from a single file
  // descriptor so an atomic rename cannot mix two snapshots.
  async read() {
    let info;
    try {
      info = await lstat(this.statePath);
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw invalid();
    }
    if (info.isSymbolicLink() || !info.isFile()) throw invalid();
    if (info.size > MAX_STATE_BYTES) throw invalid();

    let handle;
    try {
      handle = await open(this.statePath, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw invalid();
      return validate(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw invalid();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  // Run one synchronous mutation under a short-lived exclusive lock. A failed
  // mutation never writes; stale locks are surfaced, never reclaimed here.
  async transaction(mutator) {
    if (typeof mutator !== "function")
      throw new TypeError("team transaction mutator must be a function");

    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        throw new HubError(
          "team-busy",
          "Another operation is updating team state. Retry after it completes.",
        );
      throw error;
    }

    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      const state = await this.read();
      const result = mutator(state);
      if (result && typeof result.then === "function")
        throw new HubError(
          "invalid-team-transaction",
          "Team mutations must be synchronous and contain no external work.",
        );
      validate(state);
      if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES)
        throw invalid();
      await atomicJson(this.statePath, state);
      return result;
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.lockPath).catch(() => {});
    }
  }
}
