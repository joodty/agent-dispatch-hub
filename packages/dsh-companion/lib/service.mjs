import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  realpath,
  stat,
  lstat,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { SafeRuns } from "./safe-runs.mjs";
import { normalizeSnapshotLimits } from "./file-snapshots.mjs";
import {
  planPlacement,
  normalizeTargetPath,
  isWithin,
  validateTargetBinding,
} from "./placement.mjs";

const JOB = /^job-[a-f0-9-]{36}$/;
function failure(code, sessionId) {
  const e = new Error("Placement admission rejected: " + code);
  e.code = code;
  if (sessionId) e.sessionId = sessionId;
  return e;
}
function hash(v) {
  const sort = (x) =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort(x[k])]),
          )
        : x;
  return createHash("sha256")
    .update(JSON.stringify(sort(v)))
    .digest("hex");
}
async function atomic(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export class PlacementService {
  constructor({ instance, stateDir, runtime, snapshotLimits }) {
    this.instance = validateTargetBinding(instance);
    this.stateDir = stateDir;
    this.runtime = runtime;
    this.snapshotLimits = normalizeSnapshotLimits(snapshotLimits);
    this.paths = path[instance.pathStyle];
    this.records = new Map();
    this.locks = new Map();
    this.savers = new Map();
    this.safeRuns = new SafeRuns(this);
    if (
      instance.pathStyle !== (process.platform === "win32" ? "win32" : "posix")
    )
      throw failure("target-path-style-mismatch");
  }
  norm(value) {
    return normalizeTargetPath(value, this.instance.pathStyle);
  }
  same(a, b) {
    a = this.norm(a);
    b = this.norm(b);
    return this.instance.pathStyle === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  }
  within(a, b) {
    return isWithin(a, b, this.instance.pathStyle);
  }
  async directory(value) {
    try {
      const result = this.norm(await realpath(this.norm(value)));
      if (!(await stat(result)).isDirectory()) throw Error();
      return result;
    } catch {
      throw failure("directory-missing-or-invalid");
    }
  }
  async initialize() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.stateDir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      if (!JOB.test(id)) throw failure("invalid-managed-state");
      let record;
      try {
        const name = path.join(this.stateDir, file);
        if (!(await lstat(name)).isFile()) throw Error();
        record = JSON.parse(await readFile(name, "utf8"));
      } catch {
        throw failure("invalid-managed-state");
      }
      if (
        record.jobId !== id ||
        record.instanceId !== this.instance.id ||
        typeof record.sessionId !== "string" ||
        typeof record.planHash !== "string"
      )
        throw failure("invalid-managed-state");
      // Never resume incomplete admissions or touch existing backend sessions.
      delete record.initializing;
      this.records.set(id, record);
    }
    await this.safeRuns.validate();
    return this;
  }
  async inspect() {
    return {
      protocolVersion: 2,
      instance: this.instance,
      capabilities: {
        placement: true,
        instructionScopes: true,
        sandboxRequired: false,
        safeRunsVersion: this.runtime.safetySupported === true ? 1 : 0,
        snapshotLimits: this.snapshotLimits,
      },
      workspaces: await this.runtime.listWorkspaces(),
    };
  }
  save(record) {
    const previous = this.savers.get(record.jobId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        atomic(path.join(this.stateDir, record.jobId + ".json"), record),
      );
    this.savers.set(record.jobId, next);
    return next.finally(() => {
      if (this.savers.get(record.jobId) === next)
        this.savers.delete(record.jobId);
    });
  }
  prepare(args) {
    const id = args?.jobId;
    if (!JOB.test(id ?? "")) return Promise.reject(failure("invalid-job"));
    const previous = this.locks.get(id) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(() => this.prepareOne(args));
    this.locks.set(id, promise);
    return promise.finally(() => {
      if (this.locks.get(id) === promise) this.locks.delete(id);
    });
  }
  async prepareOne({ jobId, plan, safetyVersion, capability }) {
    if (
      safetyVersion !== undefined &&
      (safetyVersion !== 1 ||
        !["coding", "readonly"].includes(capability) ||
        this.runtime.safetySupported !== true)
    )
      throw failure("safe-runs-unsupported");
    if (safetyVersion === undefined && capability !== undefined)
      throw failure("invalid-capability");
    if (
      !plan ||
      plan.jobId !== jobId ||
      hash(plan.instance) !== hash(this.instance)
    )
      throw failure("instance-or-job-mismatch");
    const execution = Object.fromEntries(
      Object.entries(plan.execution ?? {}).filter(
        ([k]) => k !== "requestedCwd",
      ),
    );
    const normalized = planPlacement({
      instance: this.instance,
      jobId,
      targetName: plan.targetName,
      mappingName: plan.mappingName,
      now: plan.now,
      mapping: {
        dshWorkspace: plan.dshWorkspace,
        execution,
        source: plan.source,
        scope: plan.scope,
      },
    });
    if (hash(normalized) !== hash(plan)) throw failure("plan-mismatch");
    const planHash = hash(
      safetyVersion === 1
        ? { plan: normalized, safetyVersion, capability }
        : normalized,
    );
    const previous = this.records.get(jobId);
    if (previous) {
      if (previous.planHash !== planHash)
        throw failure("job-plan-conflict", previous.sessionId);
      if (previous.state !== "ready")
        throw failure("admission-incomplete", previous.sessionId);
      return this.verify({ jobId, sessionId: previous.sessionId });
    }
    // Validate every existing directory and canonical range before any creation.
    const source = await this.directory(plan.source.root);
    const workspaces = await this.runtime.listWorkspaces();
    let workspace;
    let workspacePath;
    if (plan.dshWorkspace.id) {
      const matches = workspaces.filter((w) => w.id === plan.dshWorkspace.id);
      if (matches.length !== 1)
        throw failure(
          matches.length ? "workspace-ambiguous" : "workspace-not-found",
        );
      workspace = matches[0];
      workspacePath = await this.directory(workspace.path);
      if (!this.same(workspacePath, workspace.path))
        throw failure("workspace-path-drift");
    } else {
      workspacePath = await this.directory(plan.dshWorkspace.path);
      const matches = workspaces.filter((w) =>
        this.same(w.path, workspacePath),
      );
      if (matches.length > 1) throw failure("workspace-ambiguous");
      workspace = matches[0];
      if (!workspace && plan.dshWorkspace.onMissing !== "create")
        throw failure("workspace-not-found");
    }
    const requested = plan.execution.requestedCwd;
    let exists = false;
    try {
      await lstat(requested);
      exists = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw failure("directory-missing-or-invalid");
    }
    const parent = await this.directory(this.paths.dirname(requested));
    const predicted = this.paths.join(parent, this.paths.basename(requested));
    const cwd = exists ? await this.directory(requested) : predicted;
    if (plan.execution.mode === "subdirectory") {
      const root = await this.directory(plan.execution.root);
      if (exists) throw failure("task-directory-already-exists");
      if (!this.within(cwd, root) || this.same(cwd, root))
        throw failure("task-directory-outside-root");
    }
    if (!exists && plan.execution.create !== true)
      throw failure("task-directory-creation-disabled");
    if (!this.within(cwd, workspacePath))
      throw failure("task-directory-outside-workspace");
    const range = async (p) =>
      this.same(p, requested) ? cwd : await this.directory(p);
    const read = await Promise.all(plan.scope.read.map(range));
    const write = await Promise.all(plan.scope.write.map(range));
    if (
      !read.some((r) => this.within(cwd, r)) ||
      !write.some((r) => this.within(cwd, r)) ||
      !read.some((r) => this.within(source, r)) ||
      write.some((w) => !read.some((r) => this.within(w, r)))
    )
      throw failure("canonical-scope-violation");
    const record = {
      jobId,
      instanceId: this.instance.id,
      sessionId: "session-" + randomUUID(),
      planHash,
      state: "preparing",
      expectedCwd: cwd,
      plan: normalized,
      ...(safetyVersion === 1 ? { safetyVersion, capability } : {}),
    };
    this.records.set(jobId, record);
    await this.save(record);
    try {
      if (!workspace)
        workspace = await this.runtime.createWorkspace(
          workspacePath,
          plan.dshWorkspace.title,
        );
      if (!workspace?.id || !this.same(workspace.path, workspacePath))
        throw failure("workspace-path-drift");
      if (!exists) {
        await mkdir(requested);
        if (!this.same(await this.directory(requested), cwd))
          throw failure("task-directory-drift");
      }
      const created = await this.runtime.createSession({
        workspaceId: workspace.id,
        sessionId: record.sessionId,
      });
      if (created.sessionId !== record.sessionId)
        throw failure("session-identity-mismatch");
      record.initializing = true;
      try {
        await this.runtime.setCwd(record.sessionId, cwd);
      } finally {
        delete record.initializing;
      }
      const observed = await this.runtime.observeSession(record.sessionId);
      if (safetyVersion === 1 && capability === "readonly")
        await this.runtime.configureReadonly(record.sessionId);
      if (
        !this.same(observed.initialCwd, workspacePath) ||
        !this.same(observed.actualCwd, cwd)
      )
        throw failure("cwd-mismatch");
      record.context = {
        instance: this.instance,
        dshWorkspace: {
          id: workspace.id,
          path: workspacePath,
          title: workspace.title,
        },
        execution: {
          requestedCwd: requested,
          actualCwd: cwd,
          initialCwd: observed.initialCwd,
        },
        source: { root: plan.source.root, canonicalRoot: source },
        scope: { read, write, enforcement: "instructions" },
        ...(safetyVersion === 1 ? { safety: { version: 1, capability } } : {}),
      };
      record.state = "ready";
      await this.save(record);
      return await this.verify({ jobId, sessionId: record.sessionId });
    } catch (error) {
      record.state = "failed";
      record.errorCode =
        typeof error.code === "string" ? error.code : "admission-failed";
      await this.save(record);
      throw failure(
        /^[a-z][a-z0-9-]{1,70}$/.test(error.code ?? "")
          ? error.code
          : "admission-failed",
        record.sessionId,
      );
    }
  }
  async verify({ jobId, sessionId } = {}) {
    const record = this.records.get(jobId);
    if (
      !record ||
      record.sessionId !== sessionId ||
      record.instanceId !== this.instance.id
    )
      throw failure("job-session-mismatch");
    if (record.state !== "ready" || !record.context)
      throw failure("admission-incomplete", sessionId);
    const c = record.context;
    const workspace = (await this.runtime.listWorkspaces()).find(
      (w) => w.id === c.dshWorkspace.id,
    );
    if (
      !workspace ||
      !workspace.sessionIds.includes(sessionId) ||
      !this.same(workspace.path, c.dshWorkspace.path)
    )
      throw failure("workspace-membership-drift", sessionId);
    if (!this.same(await this.directory(workspace.path), c.dshWorkspace.path))
      throw failure("workspace-path-drift", sessionId);
    const observed = await this.runtime.observeSession(sessionId);
    if (
      !this.same(observed.initialCwd, c.execution.initialCwd) ||
      !this.same(observed.actualCwd, c.execution.actualCwd)
    )
      throw failure("cwd-mismatch", sessionId);
    if (
      !this.same(
        await this.directory(c.execution.requestedCwd),
        c.execution.actualCwd,
      ) ||
      !this.same(
        await this.directory(c.execution.actualCwd),
        c.execution.actualCwd,
      )
    )
      throw failure("task-directory-drift", sessionId);
    if (!this.same(await this.directory(c.source.root), c.source.canonicalRoot))
      throw failure("source-path-drift", sessionId);
    for (const root of [...c.scope.read, ...c.scope.write])
      if (!this.same(await this.directory(root), root))
        throw failure("scope-path-drift", sessionId);
    // Recheck the originally configured roots too, detecting a symlink retarget.
    for (const [type, roots] of Object.entries({
      read: record.plan.scope.read,
      write: record.plan.scope.write,
    }))
      for (let i = 0; i < roots.length; i++)
        if (!this.same(await this.directory(roots[i]), c.scope[type][i]))
          throw failure("scope-path-drift", sessionId);
    return { sessionId, context: structuredClone(c) };
  }
  beginRun(args) {
    return this.safeRuns.begin(args);
  }
  finishRun(args) {
    return this.safeRuns.finish(args);
  }
  changes(args) {
    return this.safeRuns.finish(args);
  }
  async readArtifact({ jobId, sessionId, path: relative } = {}) {
    const { context: c } = await this.verify({ jobId, sessionId });
    if (
      typeof relative !== "string" ||
      !relative ||
      /[\\\u0000-\u001f]/.test(relative) ||
      relative.startsWith("/") ||
      relative.split("/").some((p) => !p || p === "." || p === "..") ||
      /^[A-Za-z]:/.test(relative)
    )
      throw failure("invalid-artifact-path");
    const file = this.norm(
      this.paths.join(c.execution.actualCwd, ...relative.split("/")),
    );
    let resolved, handle;
    try {
      if (!(await lstat(file)).isFile())
        throw failure("artifact-not-regular-file");
      resolved = this.norm(await realpath(file));
      if (
        !this.within(resolved, c.execution.actualCwd) ||
        !c.scope.read.some((root) => this.within(resolved, root))
      )
        throw failure("artifact-outside-scope");
      handle = await open(
        resolved,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const before = await handle.stat();
      const location = await stat(resolved);
      if (
        !before.isFile() ||
        before.size > 131072 ||
        before.ino !== location.ino ||
        before.dev !== location.dev
      )
        throw failure("artifact-not-readable");
      const bytes = Buffer.alloc(131073);
      let offset = 0;
      while (offset < bytes.length) {
        const got = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!got.bytesRead) break;
        offset += got.bytesRead;
      }
      const after = await handle.stat();
      if (
        offset > 131072 ||
        !this.same(await realpath(file), resolved) ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw failure("artifact-changed-or-too-large");
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, offset),
        ),
        eof: true,
        absolutePath: resolved,
      };
    } catch (e) {
      if (/^[a-z][a-z0-9-]{1,70}$/.test(e.code ?? "")) throw e;
      throw failure("artifact-not-readable");
    } finally {
      await handle?.close();
    }
  }
}
