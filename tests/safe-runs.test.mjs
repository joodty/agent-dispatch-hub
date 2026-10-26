import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SafeRuns } from "../packages/dsh-companion/lib/safe-runs.mjs";
import { isWithin } from "../packages/dsh-companion/lib/placement.mjs";
import {
  runtimeFor,
  guardManagedTools,
} from "../packages/dsh-companion/lib/runtime.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "adh-safe-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    jobs = path.join(root, "jobs");
  await mkdir(source);
  await mkdir(jobs);
  const pathStyle = process.platform === "win32" ? "win32" : "posix";
  let evidence = { terminal: false, quiescent: false };
  const service = {
    instance: { id: "test-instance", pathStyle },
    stateDir: jobs,
    records: new Map(),
    runtime: { observeRun: async () => evidence },
    within: (a, b) => isWithin(a, b, pathStyle),
    same: (a, b) =>
      pathStyle === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b,
    verify: async () => {},
    save: async (r) =>
      writeFile(path.join(jobs, r.jobId + ".json"), JSON.stringify(r)),
  };
  function job(capability = "coding") {
    const record = {
      jobId: "job-" + randomUUID(),
      sessionId: "session-" + randomUUID(),
      state: "ready",
      safetyVersion: 1,
      capability,
      context: {
        source: { canonicalRoot: source },
        scope: { write: [source] },
      },
    };
    service.records.set(record.jobId, record);
    return {
      jobId: record.jobId,
      sessionId: record.sessionId,
      requestId: randomUUID(),
    };
  }
  return {
    root,
    source,
    service,
    job,
    runs: new SafeRuns(service),
    evidence: (x) => {
      evidence = x;
    },
  };
}

test("target lease survives timeout/restart and releases only after terminal quiescence and audit", async (t) => {
  const f = await fixture(t),
    args = f.job();
  await writeFile(
    path.join(f.source, "before.txt"),
    "private-file-content-before",
  );
  const first = await f.runs.begin(args);
  assert.equal(first.state, "running");
  assert.equal(first.baseline, undefined);
  await writeFile(path.join(f.source, "before.txt"), "after");
  await writeFile(path.join(f.source, "new.txt"), "new");
  const restarted = new SafeRuns(f.service);
  f.evidence({ terminal: true, quiescent: false });
  assert.equal(
    (await restarted.finish({ ...args, completed: true })).state,
    "running",
  );
  assert.equal((await restarted.leases.list()).length, 1);
  f.evidence({ terminal: true, quiescent: true, userSeq: 1, terminalSeq: 8 });
  const done = await restarted.finish(args);
  assert.equal(done.state, "finished");
  assert.deepEqual(
    done.changes.map((c) => [c.path, c.change]),
    [
      ["before.txt", "modified"],
      ["new.txt", "added"],
    ],
  );
  assert.equal((await restarted.leases.list()).length, 0);
  assert.deepEqual(await restarted.finish(args), done);
  assert.equal(
    JSON.stringify(done).includes("private-file-content-before"),
    false,
  );
});

test("explicit snapshot limits are frozen with the baseline and later target configuration cannot weaken them", async (t) => {
  const f = await fixture(t),
    a = f.job();
  f.service.snapshotLimits = { maxFileBytes: 10 };
  await f.runs.begin(a);
  f.service.snapshotLimits = { maxFileBytes: 1000 };
  await writeFile(path.join(f.source, "larger.txt"), "12345678901");
  f.evidence({ terminal: true, quiescent: true });
  await assert.rejects(f.runs.finish(a), { code: "limit-file-bytes" });
  assert.equal((await f.runs.leases.list()).length, 1);
});

test("coding jobs conflict on source despite independent request identities; shared readonly jobs coexist", async (t) => {
  const f = await fixture(t),
    a = f.job("readonly"),
    b = f.job("readonly"),
    c = f.job();
  await f.runs.begin(a);
  await f.runs.begin(b);
  await assert.rejects(f.runs.begin(c));
  assert.equal((await f.runs.leases.list()).length, 2);
  f.evidence({ terminal: true, quiescent: true });
  assert.deepEqual((await f.runs.finish(a)).changes, []);
  assert.equal((await f.runs.leases.list()).length, 1);
});

test("run identity is fixed and another request cannot bypass an active lease", async (t) => {
  const f = await fixture(t),
    a = f.job();
  await f.runs.begin(a);
  assert.equal((await f.runs.begin(a)).requestId, a.requestId);
  await assert.rejects(f.runs.begin({ ...a, requestId: randomUUID() }), {
    code: "source-run-active",
  });
  await assert.rejects(
    f.runs.finish({ ...a, sessionId: "session-" + randomUUID() }),
    { code: "safe-run-job-mismatch" },
  );
  f.evidence({ terminal: true, quiescent: true });
  await f.runs.finish(a);
  await assert.rejects(f.runs.begin(a), { code: "request-already-recorded" });
});

test("failed after snapshot retains the lease and can be retried after repair", async (t) => {
  const f = await fixture(t),
    a = f.job();
  await f.runs.begin(a);
  await writeFile(
    path.join(f.source, "too-big"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  f.evidence({ terminal: true, quiescent: true });
  await assert.rejects(f.runs.finish(a));
  assert.equal((await f.runs.leases.list()).length, 1);
  await rm(path.join(f.source, "too-big"));
  assert.equal((await f.runs.finish(a)).state, "finished");
  assert.equal((await f.runs.leases.list()).length, 0);
});

test("managed execution guard blocks every write/shell/MCP/subagent even when preflight allows it", () => {
  let guard;
  const records = new Map([
    [
      "job",
      {
        sessionId: "readonly",
        safetyVersion: 1,
        capability: "readonly",
        state: "ready",
        activeRun: { state: "running" },
      },
    ],
  ]);
  const ctx = {
    tools: { guard: (g) => ((guard = g), () => {}) },
    on: () => () => {},
  };
  const dispose = guardManagedTools(ctx, {
    records,
    runtime: {
      safetySupported: true,
      readonlyAllowed: (exec) => ["read", "glob", "grep"].includes(exec.name),
    },
  });
  for (const name of [
    "write",
    "edit",
    "bash",
    "pwsh",
    "run_code",
    "mcp_write",
    "subagent",
    "cordis",
  ])
    assert.match(guard({ agent: { id: "readonly" }, name }), /Readonly/);
  for (const name of ["read", "glob", "grep"])
    assert.equal(guard({ agent: { id: "readonly" }, name }), undefined);
  records.get("job").activeRun.state = "finished";
  assert.match(guard({ agent: { id: "readonly" }, name: "read" }), /lease/);
  assert.equal(guard({ agent: { id: "unmanaged" }, name: "write" }), undefined);
  dispose();
});

test("runtime completion requires the original unique request, terminal events and live empty inbox", async () => {
  let events = [],
    status = "idle",
    nextTurn = [];
  const ctx = {
    workspaceRegistry: { list: () => [], create: () => {} },
    sessionController: { create: () => {} },
    agents: {
      get: () => ({ status, inbox: { nextTurn, nextStep: [] } }),
      list: () => [],
      isOwnedBy: () => false,
    },
    workingDirectory: {
      set: () => {},
      ensure: () => {},
      get: () => {},
      directory: () => {},
    },
    sessionQuery: { observeSession: async () => ({ events }) },
  };
  const runtime = runtimeFor(ctx),
    requestId = randomUUID();
  events = [
    {
      type: "user/message",
      seq: 1,
      data: { source: { kind: "user", rpcId: requestId } },
    },
    { type: "turn/end", seq: 8 },
  ];
  assert.equal((await runtime.observeRun("s", requestId)).terminal, true);
  status = "running";
  assert.equal((await runtime.observeRun("s", requestId)).quiescent, false);
  status = "idle";
  nextTurn = [{}];
  assert.equal((await runtime.observeRun("s", requestId)).quiescent, false);
  nextTurn = [];
  assert.equal((await runtime.observeRun("s", randomUUID())).terminal, false);
  events.push({ ...events[0], seq: 9 });
  assert.equal((await runtime.observeRun("s", requestId)).terminal, false);
});

test("native descendant agents retain their parent's lease until their activity and inbox settle", async () => {
  const parent = {
      id: "parent",
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
    },
    child = {
      id: "child",
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
    },
    grandchild = {
      id: "grandchild",
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
    };
  const agents = [parent, child, grandchild],
    requestId = randomUUID();
  const runtime = runtimeFor({
    agents: {
      get: (id) => agents.find((a) => a.id === id),
      list: () => agents,
      isOwnedBy: (id, owner) =>
        (id === "child" && owner === parent) ||
        (id === "grandchild" && owner === child),
    },
    workspaceRegistry: { list: () => [], create: () => {} },
    sessionController: { create: () => {} },
    workingDirectory: {
      set: () => {},
      ensure: () => {},
      get: () => {},
      directory: () => {},
    },
    sessionQuery: {
      observeSession: async () => ({
        events: [
          {
            type: "user/message",
            seq: 1,
            data: { source: { kind: "user", rpcId: requestId } },
          },
          { type: "turn/end", seq: 9 },
        ],
      }),
    },
  });
  assert.equal(runtime.ownsAgent(grandchild, "parent"), true);
  assert.equal(
    (await runtime.observeRun("parent", requestId)).quiescent,
    false,
  );
  grandchild.status = "idle";
  child.inbox.nextTurn.push({});
  assert.equal(
    (await runtime.observeRun("parent", requestId)).quiescent,
    false,
  );
  child.inbox.nextTurn = [];
  assert.equal((await runtime.observeRun("parent", requestId)).quiescent, true);
  let guard;
  const record = {
    sessionId: "parent",
    safetyVersion: 1,
    capability: "coding",
    state: "ready",
    activeRun: { state: "finished" },
  };
  const dispose = guardManagedTools(
    { tools: { guard: (g) => ((guard = g), () => {}) }, on: () => () => {} },
    {
      runtime: { ...runtime, safetySupported: true },
      records: new Map([["job", record]]),
    },
  );
  assert.match(guard({ agent: grandchild, name: "write" }), /lease/);
  dispose();
});

test("persisted descendants remain guarded and their cold inbox is checked without resuming them", async () => {
  const requestId = randomUUID(),
    parent = {
      id: "parent",
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
    };
  let queued = [{}],
    observed = 0;
  const runtime = runtimeFor({
    agents: {
      get: (id) => (id === "parent" ? parent : undefined),
      list: () => [parent],
      isOwnedBy: () => false,
    },
    workspaceRegistry: { list: () => [], create: () => {} },
    sessionController: { create: () => {} },
    workingDirectory: {
      set: () => {},
      ensure: () => {},
      get: () => {},
      directory: () => {},
    },
    sessionQuery: {
      observeSession: async (id) => {
        observed++;
        return id === "parent"
          ? {
              events: [
                {
                  type: "user/message",
                  seq: 1,
                  data: { source: { kind: "user", rpcId: requestId } },
                },
                { type: "turn/end", seq: 9 },
              ],
            }
          : {
              events: [{ type: "turn/end", seq: 4 }],
              projections: {
                values: { inbox: { "next-turn": queued, "next-step": [] } },
              },
            };
      },
    },
  });
  assert.equal(
    (await runtime.observeRun("parent", requestId, ["child"])).quiescent,
    false,
  );
  queued = [];
  assert.equal(
    (await runtime.observeRun("parent", requestId, ["child"])).quiescent,
    true,
  );
  assert.equal(observed, 4);
  let guard;
  const dispose = guardManagedTools(
    { tools: { guard: (g) => ((guard = g), () => {}) }, on: () => () => {} },
    {
      runtime: { ...runtime, safetySupported: true },
      records: new Map([
        [
          "job",
          {
            sessionId: "parent",
            descendantSessionIds: ["child"],
            safetyVersion: 1,
            capability: "coding",
            state: "ready",
            activeRun: { state: "finished" },
          },
        ],
      ]),
    },
  );
  assert.match(guard({ agent: { id: "child" }, name: "write" }), /lease/);
  dispose();
});

test("readonly setup keeps native presentation, freezes tool identities and never changes model configuration", async () => {
  const definitions = new Map(
    ["read", "glob", "grep", "write"].map((name) => [name, { name }]),
  );
  let mask,
    presentations = 0;
  const tools = {
    guard: () => () => {},
    get: (name) => definitions.get(name),
    restrict: (filter) => ((mask = filter), () => {}),
    presentAs: () => {
      presentations++;
      return () => {};
    },
    wireSchemas: () => ({ schemas: [...definitions.values()] }),
  };
  const agent = {
    id: "test",
    ctx: { tools },
    model: { model: "keep-current" },
  };
  const runtime = runtimeFor({
    tools,
    agents: { get: () => agent, list: () => [agent], isOwnedBy: () => false },
    workspaceRegistry: { list: () => [], create: () => {} },
    sessionController: { create: () => {} },
    workingDirectory: {
      set: () => {},
      ensure: () => {},
      get: () => {},
      directory: () => {},
    },
    sessionQuery: { observeSession: () => {} },
  });
  await runtime.configureReadonly("test");
  assert.deepEqual(mask.allow, ["read", "glob", "grep"]);
  assert.equal(presentations, 0);
  assert.equal(runtime.readonlyAllowed({ agent, name: "read" }), true);
  assert.equal(runtime.readonlyAllowed({ agent, name: "write" }), false);
  definitions.set("read", { name: "read", sideEffect: "replacement" });
  assert.equal(runtime.readonlyAllowed({ agent, name: "read" }), false);
  assert.deepEqual(agent.model, { model: "keep-current" });
  runtime.disposeSafety();
});
