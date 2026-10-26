import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlacementService } from "../packages/dsh-companion/lib/service.mjs";
import { planPlacement } from "../packages/dsh-companion/lib/placement.mjs";
const id = (n) => `job-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture(t, { workspaceExists = true } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "adh-placement-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const group = path.join(base, "group"),
    root = path.join(group, "tasks"),
    source = path.join(base, "source"),
    outside = path.join(base, "outside");
  for (const p of [root, source, outside]) await mkdir(p, { recursive: true });
  const instance = {
    id: "dummy-instance",
    pathStyle: process.platform === "win32" ? "win32" : "posix",
  };
  const workspaces = workspaceExists
    ? [{ id: "workspace-test", path: group, title: "Test", sessionIds: [] }]
    : [];
  const sessions = new Map(),
    calls = [];
  const runtime = {
    listWorkspaces: async () => structuredClone(workspaces),
    createWorkspace: async (p, title) => {
      calls.push("workspace");
      const w = {
        id: "workspace-created",
        path: p,
        title: title ?? "Created",
        sessionIds: [],
      };
      workspaces.push(w);
      return w;
    },
    createSession: async ({ sessionId, workspaceId }) => {
      calls.push("session");
      assert.ok(!sessions.has(sessionId));
      const w = workspaces.find((w) => w.id === workspaceId);
      assert.ok(w);
      sessions.set(sessionId, { initialCwd: w.path, actualCwd: w.path });
      w.sessionIds.push(sessionId);
      return { sessionId };
    },
    setCwd: async (sessionId, cwd) => {
      calls.push("cwd");
      sessions.get(sessionId).actualCwd = cwd;
      return cwd;
    },
    observeSession: async (sessionId) =>
      structuredClone(sessions.get(sessionId)),
  };
  const stateDir = path.join(base, "state");
  const service = await new PlacementService({
    instance,
    stateDir,
    runtime,
  }).initialize();
  const mapping = {
    dshWorkspace: { id: "workspace-test", onMissing: "error" },
    execution: {
      mode: "subdirectory",
      root,
      template: "{date}-{jobId}",
      create: true,
    },
    source: { root: source },
    scope: {
      read: [source, "{taskCwd}"],
      write: ["{taskCwd}"],
      enforcement: "instructions",
    },
  };
  const plan = (n = 1, m = mapping) =>
    planPlacement({
      instance,
      mapping: m,
      targetName: "test",
      mappingName: "project",
      jobId: id(n),
      now: Date.UTC(2026, 0, 1),
    });
  return {
    base,
    group,
    root,
    source,
    outside,
    instance,
    runtime,
    stateDir,
    service,
    mapping,
    plan,
    sessions,
    workspaces,
    calls,
  };
}
test("prepare groups a new session, preserves independent effective cwd and records source/scopes", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ jobId: id(1), plan: f.plan(1) }),
    b = await f.service.prepare({ jobId: id(2), plan: f.plan(2) });
  assert.equal(a.context.dshWorkspace.id, "workspace-test");
  assert.equal(a.context.execution.initialCwd, f.group);
  assert.notEqual(a.context.execution.actualCwd, b.context.execution.actualCwd);
  assert.equal(a.context.source.canonicalRoot, f.source);
  assert.deepEqual(a.context.scope.write, [a.context.execution.actualCwd]);
  assert.deepEqual(f.calls, ["session", "cwd", "session", "cwd"]);
  assert.deepEqual(
    await f.service.verify({ jobId: id(1), sessionId: a.sessionId }),
    a,
  );
});
test("same-job concurrent prepare and restart retry are idempotent; changed plan is rejected", async (t) => {
  const f = await fixture(t);
  const args = { jobId: id(1), plan: f.plan() };
  const [a, b] = await Promise.all([
    f.service.prepare(args),
    f.service.prepare(args),
  ]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(f.calls.filter((c) => c === "session").length, 1);
  const restarted = await new PlacementService({
    instance: f.instance,
    stateDir: f.stateDir,
    runtime: f.runtime,
  }).initialize();
  assert.equal((await restarted.prepare(args)).sessionId, a.sessionId);
  const changed = structuredClone(f.mapping);
  changed.execution.template = "other-{jobId}";
  await assert.rejects(
    restarted.prepare({ jobId: id(1), plan: f.plan(1, changed) }),
    { code: "job-plan-conflict" },
  );
});
test("missing workspace, disabled directory creation and wrong instance fail before side effects", async (t) => {
  const f = await fixture(t, { workspaceExists: false });
  await assert.rejects(f.service.prepare({ jobId: id(1), plan: f.plan() }), {
    code: "workspace-not-found",
  });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.root), []);
  f.workspaces.push({
    id: "workspace-test",
    path: f.group,
    title: "Test",
    sessionIds: [],
  });
  const mapping = structuredClone(f.mapping);
  mapping.execution.create = false;
  await assert.rejects(
    f.service.prepare({ jobId: id(2), plan: f.plan(2, mapping) }),
    { code: "task-directory-creation-disabled" },
  );
  const bad = structuredClone(f.plan(3));
  bad.instance.id = "other";
  await assert.rejects(f.service.prepare({ jobId: id(3), plan: bad }), {
    code: "instance-or-job-mismatch",
  });
  assert.deepEqual(f.calls, []);
});
test("workspace registration requires explicit creation and never creates the workspace directory", async (t) => {
  const f = await fixture(t, { workspaceExists: false });
  const m = structuredClone(f.mapping);
  m.dshWorkspace = { path: f.group, onMissing: "create", title: "Explicit" };
  const a = await f.service.prepare({ jobId: id(1), plan: f.plan(1, m) });
  assert.equal(a.context.dshWorkspace.title, "Explicit");
  assert.equal(f.calls[0], "workspace");
  m.dshWorkspace.path = path.join(f.base, "missing");
  await assert.rejects(
    f.service.prepare({ jobId: id(2), plan: f.plan(2, m) }),
    { code: "directory-missing-or-invalid" },
  );
});
test("a new subdirectory cannot reuse another task's existing directory", async (t) => {
  const f = await fixture(t);
  const plan = f.plan();
  await mkdir(plan.execution.requestedCwd);
  await assert.rejects(f.service.prepare({ jobId: id(1), plan }), {
    code: "task-directory-already-exists",
  });
  assert.deepEqual(f.calls, []);
});
test("native workspace membership, effective cwd and missing task directory all fail closed", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ jobId: id(1), plan: f.plan() });
  f.sessions.get(a.sessionId).actualCwd = f.group;
  await assert.rejects(
    f.service.verify({ jobId: id(1), sessionId: a.sessionId }),
    { code: "cwd-mismatch" },
  );
  f.sessions.get(a.sessionId).actualCwd = a.context.execution.actualCwd;
  f.workspaces[0].sessionIds = [];
  await assert.rejects(
    f.service.verify({ jobId: id(1), sessionId: a.sessionId }),
    { code: "workspace-membership-drift" },
  );
  f.workspaces[0].sessionIds = [a.sessionId];
  await rm(a.context.execution.actualCwd, { recursive: true });
  await assert.rejects(
    f.service.verify({ jobId: id(1), sessionId: a.sessionId }),
    { code: "directory-missing-or-invalid" },
  );
  assert.equal(
    f.sessions.get(a.sessionId).actualCwd,
    a.context.execution.actualCwd,
  );
});
test("artifact API reads actual cwd, rejects traversal, symlink escape and oversized files", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ jobId: id(1), plan: f.plan() });
  const args = { jobId: id(1), sessionId: a.sessionId };
  const cwd = a.context.execution.actualCwd;
  await writeFile(path.join(cwd, "result.json"), '{"ok":true}');
  const result = await f.service.readArtifact({ ...args, path: "result.json" });
  assert.equal(result.absolutePath, path.join(cwd, "result.json"));
  assert.equal(result.text, '{"ok":true}');
  for (const p of [
    "../result.json",
    "/result.json",
    "D:/result.json", // release-check:ignore synthetic target-path fixture
    "dir\\result.json",
    "dir/../result.json",
  ])
    await assert.rejects(f.service.readArtifact({ ...args, path: p }), {
      code: "invalid-artifact-path",
    });
  await writeFile(path.join(f.outside, "secret.txt"), "outside");
  await symlink(
    f.outside,
    path.join(cwd, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.service.readArtifact({ ...args, path: "escape/secret.txt" }),
    { code: "artifact-outside-scope" },
  );
  await writeFile(path.join(cwd, "big.txt"), "x".repeat(131073));
  await assert.rejects(f.service.readArtifact({ ...args, path: "big.txt" }), {
    code: "artifact-not-readable",
  });
});
test("canonical source symlink escape is rejected before creating a task", async (t) => {
  const f = await fixture(t);
  await symlink(
    f.outside,
    path.join(f.source, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const m = structuredClone(f.mapping);
  m.source.root = path.join(f.source, "escape");
  await assert.rejects(
    f.service.prepare({ jobId: id(1), plan: f.plan(1, m) }),
    { code: "canonical-scope-violation" },
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.root), []);
});
test("partial admission persists its known session; retries never create or move another session", async (t) => {
  const f = await fixture(t);
  f.runtime.setCwd = async () => {
    throw Error("private backend failure");
  };
  let sessionId;
  await assert.rejects(
    f.service.prepare({ jobId: id(1), plan: f.plan() }),
    (e) => {
      sessionId = e.sessionId;
      return e.code === "admission-failed" && !!sessionId;
    },
  );
  const saved = JSON.parse(
    await readFile(path.join(f.stateDir, id(1) + ".json"), "utf8"),
  );
  assert.equal(saved.sessionId, sessionId);
  assert.equal(saved.state, "failed");
  await assert.rejects(f.service.prepare({ jobId: id(1), plan: f.plan() }), {
    code: "admission-incomplete",
  });
  assert.equal(f.calls.filter((c) => c === "session").length, 1);
});
