// Independent failure-recovery suite for placement v2 (merge target: tests/).
//
// Scenarios covered here, each isolated from hub.test.mjs:
//   1. prompt admitted but the response was lost -> pendingPrompt is durable,
//      a second send is refused, and retry only re-confirms the recorded
//      request identity (it never posts the prompt a second time);
//   2. the same lost-response path on dispatch's first prompt, followed by wait;
//   3. a completed wait closes the uncertainty window without resending;
//   4. an unconfirmed retry stays uncertain and posts nothing;
//   5. prepare timeout -> recover() re-uses the frozen job id/plan, never prompts;
//   6. config changes never re-point an old job, and receipt() is local-only;
//   7. recover refuses a re-pointed mapping and never re-plans the frozen job;
//   8. placement drift after a completed turn keeps the backend result visible;
//   9. prompt admission requires a valid cursor and preserves the recorded identity.
//
// The Hub is exercised through its public surface with the in-memory adapter
// registry copied from tests/hub.test.mjs and narrowed to the recovery contract:
// cursor(), send({requestId, afterSeq}), confirmPrompt({requestId, afterSeq}),
// prepare(), verify(), wait(). Reconfirmation is read-only: the suite asserts
// that retry never adds another send() call, whether or not the request is
// visible in the backend yet.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, Hub } from "../src/core/hub.mjs";
import { HubError, atomicJson, loadConfig } from "../src/core/state.mjs";

const mapping = (root) => ({
  dshWorkspace: { id: "workspace-test", onMissing: "error" },
  execution: { mode: "subdirectory", root, template: "{date}-{jobId}", create: true },
  source: { root: "/source" },
  scope: {
    read: ["/source", "{taskCwd}"],
    write: ["{taskCwd}"],
    enforcement: "instructions",
  },
});

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the operation to be rejected");
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "adh-recovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, "config.json"), {
    version: 2,
    defaultTarget: "office",
    targets: Object.fromEntries(
      ["office", "home"].map((name) => [
        name,
        {
          adapter: "fake",
          instance: { id: `${name}-instance`, pathStyle: "posix" },
          connection:
            name === "office"
              ? { kind: "local", connectionFile: "/office" }
              : { kind: "remote", baseUrl: "https://example.com" },
          workspaces: { demo: mapping(`/${name}/tasks`) },
        },
      ]),
    ),
  });
  // `overrides` lets one test replace a single adapter verb at call time; the
  // default verb set is the "everything works" backend.
  const state = { calls: [], contexts: new Map(), overrides: {}, cursor: 0 };
  const registry = new AdapterRegistry().register("fake", (target) => {
    const base = {
      assertInstance: async (instance) => {
        state.calls.push(["instance", target.name, instance.id]);
      },
      cursor: async ({ sessionId }) => {
        state.calls.push(["cursor", target.name, sessionId]);
        state.cursor += 1;
        return { afterSeq: state.cursor * 100 };
      },
      prepare: async ({ jobId, plan }) => {
        state.calls.push(["prepare", target.name, jobId]);
        const context = {
          instance: plan.instance,
          dshWorkspace: { id: "workspace-test", path: `/${target.name}`, title: "Test" },
          execution: {
            requestedCwd: plan.execution.requestedCwd,
            actualCwd: plan.execution.requestedCwd,
            initialCwd: `/${target.name}`,
          },
          source: plan.source,
          scope: plan.scope,
        };
        state.contexts.set(jobId, context);
        return { sessionId: `session-${jobId}`, context };
      },
      verify: async ({ jobId }) => {
        state.calls.push(["verify", target.name, jobId]);
        return { context: state.contexts.get(jobId) };
      },
      // Read-only re-confirmation of the recorded request: never posts a prompt.
      confirmPrompt: async ({ sessionId, requestId, afterSeq }) => {
        state.calls.push(["confirm", target.name, { sessionId, requestId, afterSeq }]);
        return { accepted: true, sessionId, requestId, afterSeq, promptSent: false };
      },
      send: async (args) => {
        state.calls.push(["send", target.name, args]);
        return { requestId: args.requestId, afterSeq: args.afterSeq, accepted: true };
      },
      wait: async (args) => {
        state.calls.push(["wait", target.name, args]);
        return { completed: true, status: "completed" };
      },
      messages: async () => ({ messages: [] }),
      cancel: async () => ({ accepted: true }),
      observeLegacy: async () => ({ initialCwd: "/old", actualCwd: "/old", dshWorkspace: null }),
      readArtifact: async () => ({ text: "", eof: true, absolutePath: "/x" }),
      close() {},
    };
    const adapter = {};
    for (const [name, method] of Object.entries(base))
      adapter[name] = (...args) =>
        state.overrides[name] ? state.overrides[name](...args, base) : method(...args);
    return adapter;
  });
  return { home, hub: new Hub({ home, registry }), state };
}

test("a lost prompt response keeps the recorded identity and refuses a second prompt", async (t) => {
  const f = await fixture(t);
  const job = await f.hub.dispatch({ workspace: "demo", text: "dispatch task" });
  const attempts = [];
  const queued = new Set();
  f.state.overrides.cursor = async () => ({ afterSeq: 777 });
  f.state.overrides.send = async (args) => {
    attempts.push({ requestId: args.requestId, afterSeq: args.afterSeq, text: args.text });
    queued.add(args.requestId);
    // The backend admitted the prompt, then the response was lost.
    if (attempts.length === 1) throw new HubError("request-timeout", "The prompt response was lost.");
    return { requestId: args.requestId, afterSeq: args.afterSeq, accepted: true };
  };

  const lost = await rejection(f.hub.operate("send", { jobId: job.jobId, text: "retry me exactly" }));
  assert.equal(lost.code, "prompt-admission-uncertain");
  assert.equal(attempts.length, 1);

  const pending = await f.hub.receipt({ jobId: job.jobId });
  assert.equal(pending.state, "prompt-admission-uncertain");
  assert.equal(pending.pendingPrompt.requestId, attempts[0].requestId);
  assert.equal(pending.pendingPrompt.afterSeq, 777);
  assert.equal(typeof pending.pendingPrompt.textHash, "string");
  assert.equal(pending.pendingPrompt.text, undefined);
  assert.equal(pending.requestId, attempts[0].requestId);
  assert.equal(pending.afterSeq, 777);
  const raw = await readFile(join(f.home, "jobs", job.jobId + ".json"), "utf8");
  assert.ok(!raw.includes("retry me exactly"));
  assert.ok(!raw.includes("The prompt response was lost."));

  // The uncertainty window refuses a second prompt before backend contact.
  const blocked = await rejection(f.hub.operate("send", { jobId: job.jobId, text: "retry me exactly" }));
  assert.equal(blocked.code, "prompt-admission-uncertain");
  assert.equal(attempts.length, 1);

  // A different task text cannot be retried under the recorded identity.
  const mismatch = await rejection(f.hub.retryPrompt({ jobId: job.jobId, text: "different task" }));
  assert.equal(mismatch.code, "retry-text-mismatch");
  assert.equal(attempts.length, 1);
  assert.equal(f.state.calls.filter((call) => call[0] === "confirm").length, 0);

  // The identical text only re-confirms the recorded request; nothing is re-sent.
  const retried = await f.hub.retryPrompt({ jobId: job.jobId, text: "retry me exactly" });
  assert.equal(retried.requestId, attempts[0].requestId);
  assert.equal(retried.afterSeq, 777);
  assert.equal(retried.promptSent, false);
  assert.equal(attempts.length, 1);
  assert.equal(queued.size, 1);
  const confirms = f.state.calls.filter((call) => call[0] === "confirm");
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0][2].requestId, attempts[0].requestId);
  assert.equal(confirms[0][2].afterSeq, 777);
  const settled = await f.hub.receipt({ jobId: job.jobId });
  assert.equal(settled.pendingPrompt, undefined);
  assert.equal(settled.state, "accepted");
  assert.equal(settled.afterSeq, 777);
});

test("a first prompt lost during dispatch is confirmed once and completed by wait", async (t) => {
  const f = await fixture(t);
  const queued = new Set();
  let attempts = 0;
  f.state.overrides.send = async (args) => {
    attempts += 1;
    queued.add(args.requestId);
    if (attempts === 1) throw new HubError("request-timeout", "Transport lost after admission.");
    return { requestId: args.requestId, afterSeq: args.afterSeq, accepted: true };
  };

  const failed = await rejection(f.hub.dispatch({ workspace: "demo", text: "first task" }));
  assert.equal(failed.code, "prompt-admission-uncertain");
  const jobId = failed.details.jobId;
  const pending = await f.hub.receipt({ jobId });
  assert.equal(pending.state, "prompt-admission-uncertain");
  assert.equal(pending.sessionId, "session-" + jobId);
  assert.equal(pending.error.code, "prompt-admission-uncertain");
  assert.equal(pending.pendingPrompt.requestId, pending.requestId);
  assert.equal(pending.pendingPrompt.afterSeq, pending.afterSeq);

  const blocked = await rejection(f.hub.operate("send", { jobId, text: "first task" }));
  assert.equal(blocked.code, "prompt-admission-uncertain");
  assert.equal(attempts, 1);

  const retried = await f.hub.retryPrompt({ jobId, text: "first task" });
  assert.equal(retried.requestId, pending.requestId);
  assert.equal(retried.promptSent, false);
  assert.equal(attempts, 1); // confirmed from the backend state, never posted twice
  assert.equal(queued.size, 1);

  const waited = await f.hub.operate("wait", { jobId });
  assert.equal(waited.completed, true);
  const done = await f.hub.receipt({ jobId });
  assert.equal(done.pendingPrompt, undefined);
  assert.equal(done.state, "completed");
  assert.equal(done.backendResult.completed, true);
  assert.equal(done.requestId, pending.requestId);

  // A job with a recorded prompt identity cannot be re-prepared.
  const recovery = await rejection(f.hub.recover({ jobId }));
  assert.equal(recovery.code, "recovery-not-available");
});

test("a completed wait closes the uncertainty window without resending the prompt", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.state.overrides.send = async () => {
    attempts += 1;
    throw new HubError("request-timeout", "Transport lost.");
  };

  const failed = await rejection(f.hub.dispatch({ workspace: "demo", text: "first task" }));
  const jobId = failed.details.jobId;
  const pending = await f.hub.receipt({ jobId });
  assert.ok(pending.pendingPrompt);

  const waited = await f.hub.operate("wait", { jobId });
  assert.equal(waited.completed, true);
  const done = await f.hub.receipt({ jobId });
  assert.equal(done.pendingPrompt, undefined);
  assert.equal(done.backendResult.completed, true);
  assert.equal(done.requestId, pending.requestId);
  assert.equal(attempts, 1);
});

test("an unconfirmed retry stays uncertain and never posts the prompt again", async (t) => {
  const f = await fixture(t);
  const sends = [];
  f.state.overrides.send = async (args) => {
    sends.push(args.requestId);
    throw new HubError("request-timeout", "Transport lost.");
  };
  f.state.overrides.confirmPrompt = async () => ({ accepted: false, promptSent: false });

  const failed = await rejection(f.hub.dispatch({ workspace: "demo", text: "first task" }));
  const jobId = failed.details.jobId;
  const pending = await f.hub.receipt({ jobId });
  assert.ok(pending.pendingPrompt);

  // The backend cannot see the request yet: nothing is re-sent, uncertainty stays.
  const uncertain = await rejection(f.hub.retryPrompt({ jobId, text: "first task" }));
  assert.equal(uncertain.code, "prompt-admission-uncertain");
  assert.equal(sends.length, 1);
  const after = await f.hub.receipt({ jobId });
  assert.equal(after.pendingPrompt.requestId, pending.pendingPrompt.requestId);
  assert.equal(after.requestId, pending.requestId);
  assert.equal(after.state, "prompt-admission-uncertain");

  // An inconclusive wait keeps the same identity and still sends nothing.
  f.state.overrides.wait = async () => ({ completed: false, timedOut: true, status: "timed_out_running" });
  const waited = await f.hub.operate("wait", { jobId });
  assert.equal(waited.timedOut, true);
  assert.equal(sends.length, 1);
  const still = await f.hub.receipt({ jobId });
  assert.equal(still.pendingPrompt.requestId, pending.requestId);
  assert.equal(still.requestId, pending.requestId);
});

test("recover re-uses the frozen job id and plan after a prepare timeout and never prompts", async (t) => {
  const f = await fixture(t);
  let prepares = 0;
  const prepared = [];
  f.state.overrides.prepare = async (args, base) => {
    prepares += 1;
    if (prepares === 1) throw new HubError("request-timeout", "The companion did not answer in time.");
    prepared.push(args);
    return base.prepare(args);
  };

  const failed = await rejection(f.hub.dispatch({ workspace: "demo", text: "first task" }));
  assert.equal(failed.code, "request-timeout");
  const jobId = failed.details.jobId;
  const orphan = await f.hub.receipt({ jobId });
  assert.equal(orphan.sessionId, undefined);
  assert.equal(orphan.state, "error");
  assert.ok(orphan.plan);
  assert.equal(f.state.calls.filter((call) => call[0] === "send").length, 0);

  const recovered = await f.hub.recover({ jobId });
  assert.equal(recovered.jobId, jobId);
  assert.equal(recovered.promptSent, false);
  assert.equal(recovered.sessionId, "session-" + jobId);
  assert.equal(prepares, 2);
  assert.equal(prepared[0].jobId, jobId);
  assert.deepEqual(prepared[0].plan, orphan.plan);
  assert.equal(f.state.calls.filter((call) => call[0] === "send").length, 0);

  const afterRecover = await f.hub.receipt({ jobId });
  assert.equal(afterRecover.state, "prepared");
  assert.equal(afterRecover.sessionId, "session-" + jobId);
  assert.equal(afterRecover.context.execution.actualCwd, orphan.plan.execution.requestedCwd);
  assert.equal(afterRecover.error, undefined);

  // Idempotent while unprompted: same job id and same frozen plan, no new job.
  const again = await f.hub.recover({ jobId });
  assert.equal(again.jobId, jobId);
  assert.equal(prepares, 3);
  assert.deepEqual(prepared[1].plan, orphan.plan);
  const files = (await readdir(join(f.home, "jobs"))).filter((name) => name.endsWith(".json"));
  assert.deepEqual(files, [jobId + ".json"]);

  // A prepared (recovered) job accepts its first explicit send.
  const sent = await f.hub.operate("send", { jobId, text: "first task" });
  assert.match(sent.requestId, /^[a-f0-9-]{36}$/);
  const accepted = await f.hub.receipt({ jobId });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.requestId, sent.requestId);
  assert.ok(Number.isInteger(accepted.afterSeq));

  const blocked = await rejection(f.hub.recover({ jobId }));
  assert.equal(blocked.code, "recovery-not-available");
});

test("receipts stay local and an old job keeps its frozen target across config changes", async (t) => {
  const f = await fixture(t);
  const job = await f.hub.dispatch({ workspace: "demo", text: "task" });
  const frozen = await f.hub.receipt({ jobId: job.jobId });
  const callsAtStart = f.state.calls.length;

  // Switching the default target must not re-point the old job or touch its receipt.
  const config = await loadConfig(f.home);
  config.defaultTarget = "home";
  await atomicJson(join(f.home, "config.json"), config);
  assert.deepEqual(await f.hub.receipt({ jobId: job.jobId }), frozen);
  assert.equal(f.state.calls.length, callsAtStart);
  await f.hub.operate("wait", { jobId: job.jobId });
  assert.equal(f.state.calls.filter((call) => call[0] === "wait").at(-1)[1], "office");
  const settled = await f.hub.receipt({ jobId: job.jobId });

  // A changed connection fails closed before backend contact.
  config.targets.office.connection.connectionFile = "/other";
  await atomicJson(join(f.home, "config.json"), config);
  const before = f.state.calls.length;
  for (const operation of [
    () => f.hub.recover({ jobId: job.jobId }),
    () => f.hub.retryPrompt({ jobId: job.jobId, text: "next" }),
    () => f.hub.operate("send", { jobId: job.jobId, text: "next" }),
    () => f.hub.operate("wait", { jobId: job.jobId }),
  ]) {
    const error = await rejection(operation());
    assert.equal(error.code, "target-changed");
  }
  assert.equal(f.state.calls.length, before);
  assert.deepEqual(await f.hub.receipt({ jobId: job.jobId }), settled);

  // Removing the target keeps the receipt readable; operations fail closed.
  delete config.targets.office;
  await atomicJson(join(f.home, "config.json"), config);
  assert.deepEqual(await f.hub.receipt({ jobId: job.jobId }), settled);
  const missing = await rejection(f.hub.operate("wait", { jobId: job.jobId }));
  assert.equal(missing.code, "target-required");
});

test("recover refuses a re-pointed mapping and never re-plans the frozen job", async (t) => {
  const f = await fixture(t);
  let prepares = 0;
  f.state.overrides.prepare = async (args, base) => {
    prepares += 1;
    if (prepares === 1) throw new HubError("request-timeout", "The companion did not answer in time.");
    return base.prepare(args);
  };
  const failed = await rejection(f.hub.dispatch({ workspace: "demo", text: "task" }));
  const jobId = failed.details.jobId;
  const original = await f.hub.receipt({ jobId });

  const config = await loadConfig(f.home);
  config.targets.office.workspaces.demo.source.root = "/source/moved";
  await atomicJson(join(f.home, "config.json"), config);
  const mapped = await rejection(f.hub.recover({ jobId }));
  assert.equal(mapped.code, "mapping-changed");
  assert.equal(prepares, 1);
  assert.deepEqual(await f.hub.receipt({ jobId }), original);

  // Restoring the mapping recovers the original plan, not the new one.
  config.targets.office.workspaces.demo.source.root = "/source";
  await atomicJson(join(f.home, "config.json"), config);
  const recovered = await f.hub.recover({ jobId });
  assert.equal(recovered.context.execution.requestedCwd, original.plan.execution.requestedCwd);
  assert.equal(recovered.context.source.root, "/source");
  assert.equal(prepares, 2);
});

test("placement drift keeps the completed backend result and blocks new prompts", async (t) => {
  const f = await fixture(t);
  let drift = false;
  f.state.overrides.wait = async () => {
    drift = true;
    return { completed: true, status: "completed", output: "retained-result" };
  };
  f.state.overrides.verify = async (args, base) => {
    if (drift) throw new HubError("directory-missing-or-invalid", "Task directory missing.");
    return base.verify(args);
  };

  const failed = await rejection(f.hub.dispatch({ workspace: "demo", text: "task" }));
  assert.equal(failed.code, "directory-missing-or-invalid");
  const jobId = failed.details.jobId;
  const receipt = await f.hub.receipt({ jobId });
  assert.equal(receipt.backendResult.completed, true);
  assert.equal(receipt.backendResult.output, "retained-result");
  assert.equal(receipt.placementError.code, "directory-missing-or-invalid");
  assert.equal(receipt.pendingPrompt, undefined);
  assert.equal(receipt.state, "error");
  assert.equal(f.state.calls.filter((call) => call[0] === "send").length, 1);

  // New prompts fail closed without overwriting the retained backend evidence.
  const blocked = await rejection(f.hub.operate("send", { jobId, text: "next" }));
  assert.equal(blocked.code, "directory-missing-or-invalid");
  assert.deepEqual((await f.hub.receipt({ jobId })).backendResult, receipt.backendResult);

  // A wait still reports the placement error yet keeps the terminal result.
  const waited = await rejection(f.hub.operate("wait", { jobId }));
  assert.equal(waited.code, "directory-missing-or-invalid");
  const after = await f.hub.receipt({ jobId });
  assert.equal(after.backendResult.output, "retained-result");
  assert.equal(after.backendResult.completed, true);
  assert.equal(after.placementError.code, "directory-missing-or-invalid");
});

test("prompt admission requires a valid cursor and preserves the recorded identity", async (t) => {
  const f = await fixture(t);
  const job = await f.hub.dispatch({ workspace: "demo", text: "first task" });

  // Without a durable cursor nothing is sent and nothing is left pending.
  f.state.overrides.cursor = async () => ({ afterSeq: "12" });
  const cursor = await rejection(f.hub.operate("send", { jobId: job.jobId, text: "next" }));
  assert.equal(cursor.code, "invalid-prompt-admission");
  let receipt = await f.hub.receipt({ jobId: job.jobId });
  assert.equal(receipt.pendingPrompt, undefined);
  assert.equal(receipt.requestId, job.requestId);

  // A backend that echoes a different identity becomes an uncertain admission.
  delete f.state.overrides.cursor;
  f.state.overrides.send = async (args) => ({
    requestId: "00000000-0000-4000-8000-000000000000",
    afterSeq: args.afterSeq,
    accepted: true,
  });
  const mismatch = await rejection(f.hub.operate("send", { jobId: job.jobId, text: "next" }));
  assert.equal(mismatch.code, "prompt-admission-uncertain");
  receipt = await f.hub.receipt({ jobId: job.jobId });
  assert.equal(receipt.state, "prompt-admission-uncertain");
  assert.equal(receipt.promptError.code, "prompt-identity-mismatch");
  assert.equal(receipt.pendingPrompt.requestId, receipt.requestId);
});
