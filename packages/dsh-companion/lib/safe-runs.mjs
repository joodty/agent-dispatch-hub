import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { SourceLeaseStore } from "./source-leases.mjs";
import { captureSnapshot, diffSnapshots } from "./file-snapshots.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(code) {
  const error = new Error("Safe run rejected: " + code);
  error.code = code;
  return error;
}
async function atomic(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

// This store belongs to the execution target, independently of controller life.
// Completion is observed from DSH; callers cannot assert that a run has stopped.
export class SafeRuns {
  constructor(service) {
    this.service = service;
    this.directory = path.join(path.dirname(service.stateDir), "safety");
    this.leases = new SourceLeaseStore({
      directory: path.join(this.directory, "leases"),
      instanceId: service.instance.id,
      pathStyle: service.instance.pathStyle,
    });
    this.writers = new Map();
  }
  serialize(jobId, fn) {
    const prior = this.writers.get(jobId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.writers.set(jobId, next);
    return next.finally(() => {
      if (this.writers.get(jobId) === next) this.writers.delete(jobId);
    });
  }
  record({ jobId, sessionId, requestId }) {
    const record = this.service.records.get(jobId);
    if (!record || record.sessionId !== sessionId || record.safetyVersion !== 1)
      throw fail("safe-run-job-mismatch");
    if (!UUID.test(requestId ?? "")) throw fail("invalid-request-id");
    return record;
  }
  file(requestId) {
    return path.join(this.directory, "runs", requestId + ".json");
  }
  async load(args) {
    this.record(args);
    let run;
    try {
      run = JSON.parse(await readFile(this.file(args.requestId), "utf8"));
    } catch {
      throw fail("safe-run-not-found-or-invalid");
    }
    if (
      run.instanceId !== this.service.instance.id ||
      run.jobId !== args.jobId ||
      run.sessionId !== args.sessionId ||
      run.requestId !== args.requestId
    )
      throw fail("safe-run-owner-mismatch");
    return run;
  }
  summary(run) {
    const { baseline, ...value } = run;
    return structuredClone(value);
  }
  async validate() {
    const leases = await this.leases.list();
    for (const record of this.service.records.values()) {
      if (record.safetyVersion === undefined) continue;
      if (
        record.safetyVersion !== 1 ||
        !["coding", "readonly"].includes(record.capability)
      )
        throw fail("invalid-safety-state");
      if (!record.activeRun) continue;
      if (
        record.descendantSessionIds !== undefined &&
        (!Array.isArray(record.descendantSessionIds) ||
          record.descendantSessionIds.some(
            (id) =>
              typeof id !== "string" || !/^session-[a-f0-9-]{36}$/.test(id),
          ))
      )
        throw fail("invalid-safety-state");
      const run = await this.load({
        jobId: record.jobId,
        sessionId: record.sessionId,
        requestId: record.activeRun.requestId,
      });
      if (run.state === "finished" && record.activeRun.state !== "finished") {
        record.activeRun.state = "finished";
        await this.service.save(record);
      }
      if (
        run.capability !== record.capability ||
        (["running", "auditing"].includes(record.activeRun.state) &&
          (run.state !== "running" ||
            !leases.some(
              (l) =>
                l.runId === run.runId &&
                l.jobId === run.jobId &&
                l.sessionId === run.sessionId &&
                l.requestId === run.requestId,
            )))
      )
        throw fail("invalid-safety-state");
    }
  }
  begin(args) {
    return this.serialize(args?.jobId, () => this.beginOne(args));
  }
  async beginOne(args) {
    const record = this.record(args);
    await this.service.verify(args);
    if (record.activeRun) {
      const old = await this.load({
        ...args,
        requestId: record.activeRun.requestId,
      });
      if (old.requestId === args.requestId && old.state === "running") {
        await this.leases.acquire(old);
        record.activeRun.state = "running";
        await this.service.save(record);
        return this.summary(old);
      }
      if (old.state !== "finished") throw fail("source-run-active");
    }
    // Reusing a completed identity must never establish another prompt window.
    try {
      await readFile(this.file(args.requestId));
      throw fail("request-already-recorded");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const c = record.context;
    const roots = [...new Set([c.source.canonicalRoot, ...c.scope.write])];
    const run = {
      version: 1,
      instanceId: this.service.instance.id,
      runId: "run-" + args.requestId,
      jobId: args.jobId,
      sessionId: args.sessionId,
      requestId: args.requestId,
      capability: record.capability,
      mode: record.capability === "readonly" ? "read" : "write",
      changeCapture:
        record.capability === "readonly"
          ? "not-captured-readonly"
          : "metadata-snapshot",
      roots,
      state: "preparing",
      startedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.file(args.requestId)), {
      recursive: true,
      mode: 0o700,
    });
    // Persist first: a crash at any admission stage is an explicit unresolved run.
    await atomic(this.file(args.requestId), run);
    record.activeRun = { requestId: run.requestId, state: "preparing" };
    await this.service.save(record);
    try {
      await this.leases.acquire(run);
      if (run.capability === "coding") {
        const unique = c.scope.write.filter(
          (root, i, all) =>
            !all.some(
              (other, j) =>
                j !== i &&
                this.service.within(root, other) &&
                (!this.service.same(root, other) || j < i),
            ),
        );
        run.snapshotRoots = unique.map((root, i) => ({
          id: "write-" + i,
          path: root,
        }));
        run.baseline = await captureSnapshot({
          roots: run.snapshotRoots,
          limits: this.service.snapshotLimits,
        });
      }
      run.state = "running";
      await atomic(this.file(args.requestId), run);
      record.activeRun.state = "running";
      await this.service.save(record);
      return this.summary(run);
    } catch (error) {
      run.state = "admission-failed";
      run.error = { code: error.code ?? "safe-run-admission-failed" };
      record.activeRun.state = run.state;
      await atomic(this.file(args.requestId), run);
      await this.service.save(record);
      throw error;
    }
  }
  finish(args) {
    return this.serialize(args?.jobId, () => this.finishOne(args));
  }
  async finishOne(args) {
    const record = this.record(args),
      run = await this.load(args);
    if (run.state === "finished") {
      // Release is idempotent; repair a crash after recording the final audit.
      await this.leases.release(run);
      return this.summary(run);
    }
    if (run.state !== "running" && run.state !== "auditing")
      throw fail("safe-run-admission-unresolved");
    const evidence = await this.service.runtime.observeRun(
      args.sessionId,
      args.requestId,
      record.descendantSessionIds,
    );
    if (!evidence?.terminal || !evidence.quiescent) return this.summary(run);
    record.activeRun.state = "auditing";
    await this.service.save(record);
    try {
      const after =
        run.capability === "coding"
          ? await captureSnapshot({
              roots: run.snapshotRoots,
              allowMissingRoots: true,
              limits: run.baseline.limits,
            })
          : null;
      const again = await this.service.runtime.observeRun(
        args.sessionId,
        args.requestId,
        record.descendantSessionIds,
      );
      if (!again?.terminal || !again.quiescent) {
        record.activeRun.state = "running";
        await this.service.save(record);
        return this.summary(run);
      }
      run.changes = after ? diffSnapshots(run.baseline, after) : [];
      run.snapshot = after
        ? {
            roots: after.roots,
            excluded: after.excluded,
            limits: after.limits,
          }
        : null;
      run.observation = again;
      run.state = "finished";
      run.finishedAt = new Date().toISOString();
      await atomic(this.file(args.requestId), run);
      // Keep the guard closed before releasing any source lease.
      record.activeRun.state = "finished";
      await this.service.save(record);
      await this.leases.release(run);
      return this.summary(run);
    } catch (error) {
      record.activeRun.state = "running";
      await this.service.save(record);
      throw error;
    }
  }
}
