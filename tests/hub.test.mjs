import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, AdapterRegistry } from "../src/core/hub.mjs";
import {
  atomicJson,
  loadConfig,
  fingerprint,
  HubError,
} from "../src/core/state.mjs";
const mapping = (root) => ({
  dshWorkspace: { id: "workspace-test", onMissing: "error" },
  execution: {
    mode: "subdirectory",
    root,
    template: "{date}-{jobId}",
    create: true,
  },
  source: { root: "/source" },
  scope: {
    read: ["/source", "{taskCwd}"],
    write: ["{taskCwd}"],
    enforcement: "instructions",
  },
});
async function fixture(t, hooks = {}) {
  const home = await mkdtemp(join(tmpdir(), "adh-routing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, "config.json"), {
    version: 2,
    defaultTarget: "office",
    targets: Object.fromEntries(
      ["office", "home"].map((name) => [
        name,
        {
          adapter: "fake",
          instance: { id: name + "-instance", pathStyle: "posix" },
          connection:
            name === "office"
              ? { kind: "local", connectionFile: "/office" }
              : { kind: "remote", baseUrl: "https://example.com" },
          workspaces: { demo: mapping("/" + name + "/tasks") },
        },
      ]),
    ),
  });
  const calls = [],
    contexts = new Map();
  let request = 0;
  const registry = new AdapterRegistry().register("fake", (target) => ({
    assertInstance: async (instance) => {
      calls.push(["instance", target.name, instance.id]);
      if (instance.id !== target.name + "-instance")
        throw Error("wrong instance");
    },
    prepare: async ({ jobId, plan }) => {
      calls.push(["prepare", target.name, plan.execution.requestedCwd]);
      const context = {
        instance: plan.instance,
        dshWorkspace: {
          id: "workspace-test",
          path: "/" + target.name,
          title: "Test",
        },
        execution: {
          requestedCwd: plan.execution.requestedCwd,
          actualCwd: plan.execution.requestedCwd,
          initialCwd: "/" + target.name,
        },
        source: plan.source,
        scope: plan.scope,
      };
      contexts.set(jobId, context);
      return { sessionId: "session-" + jobId, context };
    },
    verify: async (args) => {
      calls.push(["verify", target.name, args.jobId]);
      return { context: contexts.get(args.jobId) };
    },
    send: async (args) => {
      calls.push(["send", target.name, args]);
      request++;
      return {
        requestId: args.requestId,
        afterSeq: args.afterSeq,
        accepted: true,
      };
    },
    cursor: async () => ({ afterSeq: request * 10 }),
    wait: async (args) => {
      calls.push(["wait", target.name, args]);
      return hooks.wait
        ? hooks.wait(args)
        : { status: "completed", completed: true };
    },
    messages: async () => ({ messages: [] }),
    cancel: async () => ({ accepted: true }),
    observeLegacy: async () => ({
      initialCwd: "/old",
      actualCwd: "/old",
      dshWorkspace: null,
    }),
    close() {},
    ...hooks.adapter,
  }));
  return { home, hub: new Hub({ home, registry }), calls, contexts };
}
test("instance/workspace/cwd/source/scopes are frozen; default switch never reroutes", async (t) => {
  const { hub, home, calls } = await fixture(t);
  const first = await hub.dispatch({ workspace: "demo", text: "task" });
  const config = await loadConfig(home);
  config.defaultTarget = "home";
  await atomicJson(join(home, "config.json"), config);
  await hub.operate("wait", { jobId: first.jobId });
  const second = await hub.dispatch({ workspace: "demo", text: "remote" });
  assert.equal(second.target, "home");
  assert.ok(second.context.execution.actualCwd.startsWith("/home/tasks/")); // release-check:ignore synthetic remote target path
  assert.ok(
    calls
      .filter((c) => c[0] === "wait")
      .slice(0, 2)
      .every((c) => c[1] === "office"),
  );
  const receipt = JSON.parse(
    await readFile(join(home, "jobs", first.jobId + ".json"), "utf8"),
  );
  assert.equal(receipt.context.dshWorkspace.id, "workspace-test");
  assert.equal(receipt.context.execution.initialCwd, "/office");
  assert.equal(receipt.context.source.root, "/source");
  assert.equal(receipt.context.scope.enforcement, "instructions");
  assert.equal(receipt.context.instance.id, "office-instance");
  const prompts = calls.filter((c) => c[0] === "send");
  assert.ok(prompts[0][2].text.includes(receipt.cwd));
});
test("changed connection or instance rejects old jobs before backend contact", async (t) => {
  const { hub, home, calls } = await fixture(t);
  const job = await hub.dispatch({ workspace: "demo", text: "task" });
  const count = calls.length;
  const config = await loadConfig(home);
  config.targets.office.connection.connectionFile = "/other";
  await atomicJson(join(home, "config.json"), config);
  await assert.rejects(hub.operate("wait", { jobId: job.jobId }), {
    code: "target-changed",
  });
  assert.equal(calls.length, count);
  config.targets.office.connection.connectionFile = "/office";
  config.targets.office.instance.id = "another";
  await atomicJson(join(home, "config.json"), config);
  await assert.rejects(hub.operate("wait", { jobId: job.jobId }), {
    code: "instance-changed",
  });
  assert.equal(calls.length, count);
});
test("policy edits block a follow-up; read/wait/cancel retain original context", async (t) => {
  const { hub, home, calls } = await fixture(t);
  const first = await hub.dispatch({ workspace: "demo", text: "task" });
  const config = await loadConfig(home);
  config.targets.office.workspaces.demo.source.root = "/source/other";
  await atomicJson(join(home, "config.json"), config);
  const sends = calls.filter((c) => c[0] === "send").length;
  await assert.rejects(
    hub.operate("send", { jobId: first.jobId, text: "next" }),
    { code: "mapping-changed" },
  );
  assert.equal(calls.filter((c) => c[0] === "send").length, sends);
  await hub.operate("messages", { jobId: first.jobId });
  await hub.operate("wait", { jobId: first.jobId });
  await hub.operate("cancel", { jobId: first.jobId });
});
test("admitted session survives backend failure and raw errors are redacted", async (t) => {
  const { hub, home } = await fixture(t, {
    wait: async () => {
      throw Error("secret-token-value");
    },
  });
  await assert.rejects(hub.dispatch({ workspace: "demo", text: "task" }), {
    code: "backend-error",
  });
  const [file] = await readdir(join(home, "jobs"));
  const receipt = JSON.parse(await readFile(join(home, "jobs", file), "utf8"));
  assert.ok(receipt.sessionId);
  assert.match(receipt.requestId, /^[a-f0-9-]{36}$/);
  assert.ok(receipt.context);
  assert.ok(!JSON.stringify(receipt).includes("secret-token"));
});
test("unmapped placement, legacy string and traversal fail without new sessions", async (t) => {
  const { hub, home, calls } = await fixture(t);
  await assert.rejects(hub.dispatch({ workspace: "unknown", text: "task" }), {
    code: "workspace-required",
  });
  await assert.rejects(hub.operate("wait", { jobId: "../credentials" }), {
    code: "invalid-job",
  });
  const config = await loadConfig(home);
  config.targets.office.workspaces.demo = "/old/path";
  await atomicJson(join(home, "config.json"), config);
  await assert.rejects(hub.dispatch({ workspace: "demo", text: "task" }), {
    code: "migration-required",
  });
  assert.equal(calls.length, 0);
});
test("v1 job requires explicit sidecar binding; binding never changes its backend session or receipt", async (t) => {
  const { hub, home, calls } = await fixture(t);
  const target = await hub.target("office");
  const id = "job-00000000-0000-4000-8000-000000000001";
  const receipt = {
    id,
    version: 1,
    target: "office",
    targetFingerprint: fingerprint(target),
    sessionId: "old-session",
    cwd: "/old",
  };
  await atomicJson(join(home, "jobs", id + ".json"), receipt);
  const before = await readFile(join(home, "jobs", id + ".json"), "utf8");
  await assert.rejects(hub.operate("wait", { jobId: id }), {
    code: "legacy-job-unbound",
  });
  await hub.bindLegacy({ jobId: id });
  await hub.operate("messages", { jobId: id });
  await assert.rejects(hub.operate("send", { jobId: id, text: "next" }), {
    code: "legacy-follow-up-disabled",
  });
  assert.equal(
    await readFile(join(home, "jobs", id + ".json"), "utf8"),
    before,
  );
  assert.ok(!calls.some((c) => ["prepare", "send"].includes(c[0])));
});
test("a stale wait cannot overwrite a follow-up or block cancellation", async (t) => {
  const { hub } = await fixture(t);
  const first = await hub.dispatch({ workspace: "demo", text: "first" });
  const original = hub.registry.factories.get("fake");
  let finishWait, startWait;
  const started = new Promise((r) => (startWait = r));
  hub.registry.factories.set("fake", (target) => ({
    ...original(target),
    wait: async () => {
      startWait();
      return new Promise((r) => (finishWait = r));
    },
  }));
  const waiting = hub.operate("wait", { jobId: first.jobId });
  await started;
  const next = await hub.operate("send", { jobId: first.jobId, text: "next" });
  await hub.operate("cancel", { jobId: first.jobId });
  finishWait({
    requestId: first.requestId,
    status: "completed",
    completed: true,
  });
  assert.equal((await waiting).superseded, true);
  const { job } = await hub.resolveJob(first.jobId);
  assert.equal(job.requestId, next.requestId);
  assert.equal(job.state, "cancellation-requested");
});

test("the initial dispatch wait cannot overwrite a concurrently admitted follow-up", async (t) => {
  let finishWait, startWait;
  const started = new Promise((r) => (startWait = r));
  const { hub, home } = await fixture(t, {
    wait: async () => {
      startWait();
      return new Promise((r) => (finishWait = r));
    },
  });
  const dispatching = hub.dispatch({ workspace: "demo", text: "first" });
  await started;
  const [file] = await readdir(join(home, "jobs"));
  const first = JSON.parse(await readFile(join(home, "jobs", file), "utf8"));
  const next = await hub.operate("send", { jobId: first.id, text: "next" });
  finishWait({ status: "completed", completed: true });
  assert.equal((await dispatching).superseded, true);
  const { job } = await hub.resolveJob(first.id);
  assert.equal(job.requestId, next.requestId);
  assert.equal(job.state, "accepted");
});

test("lost prompt response retains admission identity; explicit retry cannot enqueue twice", async (t) => {
  const { hub } = await fixture(t);
  const first = await hub.dispatch({ workspace: "demo", text: "first" });
  const original = hub.registry.factories.get("fake"),
    attempts = [],
    queued = new Set();
  hub.registry.factories.set("fake", (target) => ({
    ...original(target),
    send: async (args) => {
      attempts.push(args);
      queued.add(args.requestId);
      if (attempts.length === 1)
        throw Object.assign(Error("dummy private transport detail"), {
          code: "request-timeout",
        });
      return {
        requestId: args.requestId,
        afterSeq: args.afterSeq,
        accepted: true,
      };
    },
    confirmPrompt: async (args) => ({
      ...args,
      accepted: queued.has(args.requestId),
      promptSent: false,
    }),
  }));
  await assert.rejects(
    hub.operate("send", { jobId: first.jobId, text: "next" }),
    { code: "prompt-admission-uncertain" },
  );
  const pending = await hub.receipt({ jobId: first.jobId });
  assert.equal(pending.pendingPrompt.requestId, attempts[0].requestId);
  assert.ok(!JSON.stringify(pending).includes("private transport"));
  await assert.rejects(
    hub.operate("send", { jobId: first.jobId, text: "next" }),
    { code: "prompt-admission-uncertain" },
  );
  await assert.rejects(
    hub.retryPrompt({ jobId: first.jobId, text: "different" }),
    { code: "retry-text-mismatch" },
  );
  assert.equal(attempts.length, 1);
  const retried = await hub.retryPrompt({ jobId: first.jobId, text: "next" });
  assert.equal(retried.requestId, attempts[0].requestId);
  assert.equal(retried.afterSeq, attempts[0].afterSeq);
  assert.equal(retried.promptSent, false);
  assert.equal(attempts.length, 1);
  assert.equal(queued.size, 1);
  assert.equal(
    (await hub.receipt({ jobId: first.jobId })).pendingPrompt,
    undefined,
  );
});

test("placement drift keeps completed backend evidence locally and still rejects new prompts", async (t) => {
  let drift = false;
  const f = await fixture(t, {
    wait: async () => {
      drift = true;
      return {
        completed: true,
        status: "completed",
        output: "retained-result",
      };
    },
    adapter: {
      verify: async (args) => {
        if (drift)
          throw new HubError(
            "directory-missing-or-invalid",
            "Task directory missing",
          );
        return { context: f.contexts.get(args.jobId) };
      },
    },
  });
  let jobId;
  await assert.rejects(
    f.hub.dispatch({ workspace: "demo", text: "task" }),
    (e) => {
      jobId = e.details.jobId;
      return e.code === "directory-missing-or-invalid";
    },
  );
  const receipt = await f.hub.receipt({ jobId });
  assert.equal(receipt.backendResult.completed, true);
  assert.equal(receipt.backendResult.output, "retained-result");
  assert.equal(receipt.placementError.code, "directory-missing-or-invalid");
  await assert.rejects(f.hub.operate("send", { jobId, text: "next" }), {
    code: "directory-missing-or-invalid",
  });
  await assert.rejects(f.hub.operate("wait", { jobId }), {
    code: "directory-missing-or-invalid",
  });
  assert.equal(
    (await f.hub.receipt({ jobId })).backendResult.output,
    "retained-result",
  );
});

test("prepare acknowledgement loss recovers the frozen job without prompting or rerouting", async (t) => {
  const { hub, home, calls } = await fixture(t);
  const original = hub.registry.factories.get("fake");
  let failed = false;
  const ids = [];
  hub.registry.factories.set("fake", (target) => {
    const a = original(target);
    return {
      ...a,
      prepare: async (args) => {
        ids.push(args.jobId);
        const result = await a.prepare(args);
        if (!failed) {
          failed = true;
          throw new HubError(
            "companion-unreachable",
            "Controlled lost prepare acknowledgement",
          );
        }
        return result;
      },
    };
  });
  let jobId;
  await assert.rejects(
    hub.dispatch({ workspace: "demo", text: "task" }),
    (e) => {
      jobId = e.details.jobId;
      return e.code === "companion-unreachable";
    },
  );
  assert.equal((await hub.receipt({ jobId })).sessionId, undefined);
  const config = await loadConfig(home);
  config.defaultTarget = "home";
  await atomicJson(join(home, "config.json"), config);
  const recovered = await hub.recover({ jobId });
  assert.equal(recovered.target, "office");
  assert.equal(recovered.promptSent, false);
  assert.deepEqual(ids, [jobId, jobId]);
  assert.equal(calls.filter((c) => c[0] === "send").length, 0);
  await hub.operate("send", { jobId, text: "task" });
  assert.equal(calls.filter((c) => c[0] === "send").length, 1);
});

test("an unobserved uncertain prompt cannot be resent by retry", async (t) => {
  const { hub } = await fixture(t);
  const initial = await hub.dispatch({ workspace: "demo", text: "first" });
  const original = hub.registry.factories.get("fake");
  let posts = 0;
  hub.registry.factories.set("fake", (target) => ({
    ...original(target),
    send: async () => {
      posts++;
      throw Error("dummy unavailable acknowledgement");
    },
    confirmPrompt: async (args) => ({
      ...args,
      accepted: false,
      promptSent: false,
    }),
  }));
  await assert.rejects(
    hub.operate("send", { jobId: initial.jobId, text: "next" }),
    { code: "prompt-admission-uncertain" },
  );
  await assert.rejects(
    hub.retryPrompt({ jobId: initial.jobId, text: "next" }),
    { code: "prompt-admission-uncertain" },
  );
  assert.equal(posts, 1);
  assert.ok((await hub.receipt({ jobId: initial.jobId })).pendingPrompt);
});
