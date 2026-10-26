import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, AdapterRegistry } from "../src/core/hub.mjs";
import { atomicJson, loadConfig, HubError } from "../src/core/state.mjs";
async function fixture(t, { supported = true, timeout = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "adh-hub-safe-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const mapping = {
    dshWorkspace: { id: "workspace-test", onMissing: "error" },
    execution: {
      mode: "subdirectory",
      root: "/work/tasks",
      template: "{jobId}",
      create: true,
    },
    source: { root: "/work/source" },
    scope: {
      read: ["/work/source", "{taskCwd}"],
      write: ["{taskCwd}"],
      enforcement: "instructions",
    },
  };
  await atomicJson(join(home, "config.json"), {
    version: 2,
    defaultTarget: "office",
    targets: Object.fromEntries(
      ["office", "other"].map((name) => [
        name,
        {
          adapter: "fake",
          instance: { id: name + "-instance", pathStyle: "posix" },
          connection: { kind: "local", connectionFile: "/dummy/" + name },
          workspaces: { demo: mapping },
        },
      ]),
    ),
  });
  const state = {
    calls: [],
    contexts: new Map(),
    runState: timeout ? "running" : "finished",
    failBegin: false,
    failAudit: false,
    drift: false,
    failPrepare: false,
  };
  const registry = new AdapterRegistry().register("fake", (target) => ({
    assertInstance: async () => ({
      capabilities: { safeRunsVersion: supported ? 1 : 0 },
    }),
    prepare: async (args) => {
      state.calls.push(["prepare", target.name, args]);
      const { plan, jobId } = args;
      const context = {
        instance: plan.instance,
        dshWorkspace: { id: "workspace-test", path: "/work", title: "Test" },
        execution: {
          requestedCwd: plan.execution.requestedCwd,
          actualCwd: plan.execution.requestedCwd,
          initialCwd: "/work",
        },
        source: plan.source,
        scope: plan.scope,
        ...(args.safetyVersion
          ? { safety: { version: 1, capability: args.capability } }
          : {}),
      };
      state.contexts.set(jobId, context);
      if (state.failPrepare)
        throw new HubError("request-timeout", "Unknown placement");
      return { sessionId: "session-" + jobId.slice(4), context };
    },
    verify: async ({ jobId }) => {
      state.calls.push(["verify", target.name]);
      if (state.drift) throw new HubError("cwd-mismatch", "Drift");
      return { context: state.contexts.get(jobId) };
    },
    cursor: async () => ({ afterSeq: 0 }),
    beginRun: async (args) => {
      state.calls.push(["beginRun", target.name, args]);
      if (state.failBegin) throw new HubError("source-locked", "locked");
      return { state: "running", requestId: args.requestId };
    },
    send: async (args) => {
      state.calls.push(["send", target.name, args]);
      return {
        accepted: true,
        requestId: args.requestId,
        afterSeq: args.afterSeq,
      };
    },
    wait: async () => ({
      completed: !timeout,
      status: timeout ? "timed_out_running" : "completed",
    }),
    finishRun: async (args) => {
      state.calls.push(["finishRun", target.name, args]);
      if (state.failAudit) throw new Error("private error");
      return { state: state.runState, requestId: args.requestId, changes: [] };
    },
    changes: async (args) => {
      state.calls.push(["changes", target.name, args]);
      return { state: state.runState, requestId: args.requestId, changes: [] };
    },
    cancel: async () => ({ accepted: true }),
    close: () => {},
  }));
  return { home, hub: new Hub({ home, registry }), state };
}
test("readonly capability is frozen, lease admission precedes sending and receipts retain target audit", async (t) => {
  const { hub, state } = await fixture(t);
  const d = await hub.dispatch({
    workspace: "demo",
    text: "Review only",
    capability: "readonly",
  });
  const receipt = await hub.receipt({ jobId: d.jobId });
  assert.equal(receipt.capability, "readonly");
  assert.equal(receipt.safetyVersion, 1);
  assert.equal(receipt.context.safety.capability, "readonly");
  assert.equal(receipt.runAudit.state, "finished");
  const names = state.calls.map((c) => c[0]);
  assert.ok(names.indexOf("beginRun") < names.indexOf("send"));
  assert.ok(names.indexOf("finishRun") < names.lastIndexOf("verify"));
  assert.match(
    state.calls.find((c) => c[0] === "send")[2].text,
    /permanently readonly/,
  );
  await hub.operate("send", { jobId: d.jobId, text: "Now change files" });
  assert.equal((await hub.receipt({ jobId: d.jobId })).capability, "readonly");
});
test("older companions explicitly reject readonly before session creation and retain coding compatibility", async (t) => {
  const { hub, state } = await fixture(t, { supported: false });
  await assert.rejects(
    hub.dispatch({ workspace: "demo", text: "Review", capability: "readonly" }),
    { code: "readonly-unsupported" },
  );
  assert.equal(state.calls.length, 0);
  const d = await hub.dispatch({ workspace: "demo", text: "Task" });
  assert.deepEqual(d.safety, { supported: false });
  assert.equal(
    state.calls.some((c) => c[0] === "beginRun"),
    false,
  );
  await assert.rejects(hub.changes({ jobId: d.jobId }), {
    code: "safe-runs-unsupported",
  });
});
test("source lease admission failure never sends a prompt, preserves request and cannot be retried as a prompt", async (t) => {
  const { hub, state } = await fixture(t);
  state.failBegin = true;
  let error;
  try {
    await hub.dispatch({ workspace: "demo", text: "Task" });
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "source-locked");
  assert.equal(
    state.calls.some((c) => c[0] === "send"),
    false,
  );
  const r = await hub.receipt({ jobId: error.details.jobId });
  assert.equal(r.state, "run-admission-unconfirmed");
  assert.equal(r.pendingPrompt.stage, "run");
  await assert.rejects(hub.retryPrompt({ jobId: r.id, text: "Task" }), {
    code: "run-admission-unconfirmed",
  });
});
test("timeouts and cancellation retain the active run; changes follows the original target after default switch", async (t) => {
  const { hub, state, home } = await fixture(t, { timeout: true });
  const d = await hub.dispatch({ workspace: "demo", text: "Task" });
  await assert.rejects(
    hub.operate("send", { jobId: d.jobId, text: "Another" }),
    { code: "source-run-active" },
  );
  await hub.operate("cancel", { jobId: d.jobId });
  assert.equal(
    (await hub.receipt({ jobId: d.jobId })).runAudit.state,
    "running",
  );
  const config = await loadConfig(home);
  config.defaultTarget = "other";
  await atomicJson(join(home, "config.json"), config);
  state.runState = "finished";
  assert.equal((await hub.changes({ jobId: d.jobId })).state, "finished");
  assert.equal(state.calls.findLast((c) => c[0] === "changes")[1], "office");
});
test("audit failure retains backend evidence, and later reconciliation succeeds even with placement drift", async (t) => {
  const { hub, state } = await fixture(t);
  state.failAudit = true;
  let error;
  try {
    await hub.dispatch({ workspace: "demo", text: "Task" });
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "run-audit-unconfirmed");
  const r = await hub.receipt({ jobId: error.details.jobId });
  assert.equal(r.backendResult.completed, true);
  state.failAudit = false;
  state.drift = true;
  const done = await hub.changes({ jobId: r.id });
  assert.equal(done.state, "finished");
  assert.equal(
    (await hub.receipt({ jobId: r.id })).backendResult.completed,
    true,
  );
});
test("placement recovery preserves safety capability and never sends its first prompt", async (t) => {
  const { hub, state } = await fixture(t);
  state.failPrepare = true;
  let error;
  try {
    await hub.dispatch({
      workspace: "demo",
      text: "Review",
      capability: "readonly",
    });
  } catch (e) {
    error = e;
  }
  state.failPrepare = false;
  const result = await hub.recover({ jobId: error.details.jobId });
  assert.equal(result.promptSent, false);
  const prepares = state.calls.filter((c) => c[0] === "prepare");
  assert.equal(prepares[1][2].capability, "readonly");
  assert.equal(
    state.calls.some((c) => c[0] === "send"),
    false,
  );
});
