import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, AdapterRegistry } from "../src/core/hub.mjs";
import { atomicJson, loadConfig, HubError } from "../src/core/state.mjs";

function completedQuestion(args, overrides = {}) {
  const seq = args.afterSeq + 1;
  const envelope = {
    adhQuestion: 1,
    requestId: args.requestId,
    question: "Which implementation?",
    options: ["A", "B"],
    recommendation: "A",
    ...overrides,
  };
  return {
    status: "completed",
    completed: true,
    requestId: args.requestId,
    messages: [
      { seq, role: "user", requestId: args.requestId, text: "task" },
      { seq: seq + 1, role: "assistant", text: JSON.stringify(envelope) },
    ],
    terminalEvents: [{ seq: seq + 2, reason: { kind: "completed" } }],
  };
}

async function fixture(t, { safety = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "adh-questions-"));
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
    sends: [],
    contexts: new Map(),
    queued: new Set(),
    everyTurn: false,
    failSend: false,
    confirm: true,
    audit: "finished",
    failAudit: false,
    drift: false,
  };
  const registry = new AdapterRegistry().register("fake", (target) => ({
    assertInstance: async () => ({
      capabilities: { safeRunsVersion: safety ? 1 : 0 },
    }),
    prepare: async ({ jobId, plan, safetyVersion, capability }) => {
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
        ...(safetyVersion ? { safety: { version: 1, capability } } : {}),
      };
      state.contexts.set(jobId, context);
      return { sessionId: "session-" + jobId.slice(4), context };
    },
    verify: async ({ jobId }) => {
      if (state.drift) throw new HubError("placement-changed", "Drift");
      return { context: state.contexts.get(jobId) };
    },
    cursor: async () => ({ afterSeq: state.sends.length * 10 }),
    send: async (args) => {
      state.sends.push({ ...args, target: target.name });
      state.queued.add(args.requestId);
      if (state.failSend) throw Error("private transport details");
      return {
        accepted: true,
        requestId: args.requestId,
        afterSeq: args.afterSeq,
      };
    },
    confirmPrompt: async (args) => ({
      ...args,
      accepted: state.confirm && state.queued.has(args.requestId),
      promptSent: false,
    }),
    wait: async (args) =>
      state.wait
        ? state.wait(args)
        : state.sends.length === 1 || state.everyTurn
          ? completedQuestion(args)
          : { completed: true, status: "completed", requestId: args.requestId },
    beginRun: async (args) => ({ state: "running", requestId: args.requestId }),
    finishRun: async (args) => {
      if (state.failAudit) throw Error("audit unavailable");
      return { state: state.audit, requestId: args.requestId, changes: [] };
    },
    changes: async (args) => ({
      state: state.audit,
      requestId: args.requestId,
      changes: [],
    }),
    cancel: async () => ({ accepted: true }),
    close() {},
  }));
  const hub = new Hub({ home, registry });
  return {
    home,
    hub,
    state,
    registry,
    dispatch: (args = {}) =>
      hub.dispatch({
        target: "office",
        workspace: "demo",
        text: "Implement task",
        ...args,
      }),
  };
}

test("DSH question is durable needs_input, not task completion; answer resumes same session once", async (t) => {
  const { hub, state, dispatch } = await fixture(t);
  const d = await dispatch();
  assert.equal(d.status, "needs_input");
  assert.equal(d.completed, false);
  assert.equal(d.turnCompleted, true);
  const receipt = await hub.receipt({ jobId: d.jobId });
  assert.equal(receipt.backendResult.completed, true);
  assert.equal(receipt.state, "needs_input");
  assert.match(state.sends[0].text, /adhQuestion/);
  assert.match(state.sends[0].text, new RegExp(d.requestId));
  await assert.rejects(
    hub.operate("send", { jobId: d.jobId, text: "skip question" }),
    { code: "question-pending" },
  );
  const args = { jobId: d.jobId, questionId: d.question.id, text: "Use A" };
  const a = await hub.answer(args);
  assert.equal(a.sessionId, d.sessionId);
  assert.notEqual(a.requestId, d.requestId);
  assert.equal(state.sends[1].sessionId, d.sessionId);
  assert.match(state.sends[1].text, /Answer to question-/);
  assert.equal(state.sends[1].model, undefined);
  const again = await hub.answer(args);
  assert.equal(again.duplicate, true);
  assert.equal(again.requestId, a.requestId);
  assert.equal(state.sends.length, 2);
  await assert.rejects(hub.answer({ ...args, text: "Use B" }), {
    code: "answer-conflict",
  });
  const finished = await hub.operate("wait", { jobId: d.jobId });
  assert.equal(finished.completed, true);
  const log = await hub.questions({ jobId: d.jobId });
  assert.equal(log.questions[0].state, "answered");
  assert.equal(log.questions[0].answer.text, "Use A");
});

test("repeated waits and controller restarts preserve one stable question", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  const restarted = new Hub({ home: f.home, registry: f.registry });
  const w = await restarted.operate("wait", { jobId: d.jobId });
  assert.equal(w.question.id, d.question.id);
  assert.equal(
    (await restarted.questions({ jobId: d.jobId })).questions.length,
    1,
  );
  await restarted.answer({
    jobId: d.jobId,
    questionId: d.question.id,
    text: "A",
  });
  assert.equal(f.state.sends.length, 2);
});

test("answer follows frozen target after default switch; changed mappings and instances reject", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  const config = await loadConfig(f.home);
  config.defaultTarget = "other";
  await atomicJson(join(f.home, "config.json"), config);
  await f.hub.answer({ jobId: d.jobId, questionId: d.question.id, text: "A" });
  assert.equal(f.state.sends.at(-1).target, "office");
  const d2 = await f.dispatch();
  // Create a fresh question on the same selected instance.
  f.state.wait = (args) => completedQuestion(args);
  const w = await f.hub.operate("wait", { jobId: d2.jobId });
  config.targets.office.workspaces.demo.source.root = "/changed";
  await atomicJson(join(f.home, "config.json"), config);
  const args = { jobId: d2.jobId, questionId: w.question.id, text: "A" };
  await assert.rejects(f.hub.answer(args), { code: "mapping-changed" });
  config.targets.office.instance.id = "wrong-instance";
  await atomicJson(join(f.home, "config.json"), config);
  await assert.rejects(f.hub.answer(args), { code: "instance-changed" });
});

test("lost answer response is confirmed, never resent; conflicting retries fail", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  f.state.failSend = true;
  const args = { jobId: d.jobId, questionId: d.question.id, text: "A" };
  await assert.rejects(f.hub.answer(args), {
    code: "prompt-admission-uncertain",
  });
  assert.equal(
    (await f.hub.questions({ jobId: d.jobId })).questions[0].state,
    "answer-pending",
  );
  f.state.confirm = false;
  await assert.rejects(f.hub.answer(args), {
    code: "answer-admission-uncertain",
  });
  await assert.rejects(f.hub.answer({ ...args, text: "B" }), {
    code: "answer-conflict",
  });
  f.state.confirm = true;
  const a = await f.hub.answer(args);
  assert.equal(a.promptSent, false);
  assert.equal(f.state.sends.length, 2);
  assert.equal(
    (await f.hub.questions({ jobId: d.jobId })).questions[0].state,
    "answered",
  );
});

test("ordinary retry confirmation and completed wait also settle uncertain answer admission", async (t) => {
  for (const method of ["retry", "wait"]) {
    const f = await fixture(t);
    const d = await f.dispatch();
    f.state.failSend = true;
    await assert.rejects(
      f.hub.answer({ jobId: d.jobId, questionId: d.question.id, text: "A" }),
    );
    if (method === "retry")
      await f.hub.retryPrompt({ jobId: d.jobId, text: "A" });
    else await f.hub.operate("wait", { jobId: d.jobId });
    assert.equal(
      (await f.hub.questions({ jobId: d.jobId })).questions[0].state,
      "answered",
    );
    assert.equal(f.state.sends.length, 2);
  }
});

test("question cancellation prevents answering and ordinary follow-ups", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  await f.hub.operate("cancel", { jobId: d.jobId });
  await assert.rejects(
    f.hub.answer({ jobId: d.jobId, questionId: d.question.id, text: "A" }),
    { code: "dispatch-cancelled" },
  );
  await assert.rejects(
    f.hub.operate("send", { jobId: d.jobId, text: "continue" }),
    { code: "dispatch-cancelled" },
  );
  await f.hub.operate("wait", { jobId: d.jobId });
  assert.equal(
    (await f.hub.questions({ jobId: d.jobId })).questions[0].state,
    "cancelled",
  );
  assert.equal(f.state.sends.length, 1);
});

test("question limits fail explicitly; disabling questions preserves ordinary output", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch({ maxQuestions: 1 });
  f.state.everyTurn = true;
  await f.hub.answer({ jobId: d.jobId, questionId: d.question.id, text: "A" });
  const w = await f.hub.operate("wait", { jobId: d.jobId });
  assert.equal(w.status, "question_limit_reached");
  await assert.rejects(
    f.hub.answer({ jobId: d.jobId, questionId: w.question.id, text: "A" }),
    { code: "question-limit-reached" },
  );
  const disabled = await f.dispatch({ maxQuestions: 0 });
  assert.equal(disabled.completed, true);
  assert.doesNotMatch(f.state.sends.at(-1).text, /adhQuestion/);
  await assert.rejects(f.dispatch({ maxQuestions: -1 }), {
    code: "invalid-question-limit",
  });
});

test("streaming, tool output, quoted examples and other requests cannot become questions", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch({ maxQuestions: 0 });
  const job = await f.hub.receipt({ jobId: d.jobId });
  job.questionProtocol = { version: 1, maxQuestions: 5 };
  await atomicJson(join(f.home, "jobs", d.jobId + ".json"), job);
  for (const modify of [
    (r) => {
      r.completed = false;
      r.status = "timed_out_running";
    },
    (r) => {
      r.messages[1].role = "tool";
    },
    (r) => {
      r.messages[0].requestId = "other-request";
    },
    (r) => {
      r.messages[1].seq = r.messages[0].seq - 1;
    },
    (r) => {
      r.messages[1].text = "Example:\n" + r.messages[1].text;
    },
  ]) {
    f.state.wait = (args) => {
      const r = completedQuestion(args);
      modify(r);
      return r;
    };
    const w = await f.hub.operate("wait", { jobId: d.jobId });
    assert.equal(w.question, undefined);
  }
  assert.equal((await f.hub.questions({ jobId: d.jobId })).questions.length, 0);
});

test("invalid structured question is explicit, and old receipts are never retroactively enrolled", async (t) => {
  const f = await fixture(t);
  f.state.wait = (args) => completedQuestion(args, { requestId: "stale" });
  const d = await f.dispatch();
  assert.equal(d.status, "question_error");
  assert.equal(d.questionError.code, "invalid-question");
  assert.equal(d.completed, false);
  const job = await f.hub.receipt({ jobId: d.jobId });
  delete job.questionProtocol;
  delete job.questionError;
  await atomicJson(join(f.home, "jobs", d.jobId + ".json"), job);
  assert.equal(
    (await f.hub.operate("wait", { jobId: d.jobId })).completed,
    true,
  );
});

test("safe question turns reconcile audit; waiting is not a lease exemption; readonly survives answer", async (t) => {
  const f = await fixture(t, { safety: true });
  const d = await f.dispatch({ capability: "readonly" });
  const receipt = await f.hub.receipt({ jobId: d.jobId });
  assert.equal(receipt.runAudit.state, "finished");
  await f.hub.answer({ jobId: d.jobId, questionId: d.question.id, text: "A" });
  assert.match(f.state.sends.at(-1).text, /permanently readonly/);
  assert.equal(
    (await f.hub.receipt({ jobId: d.jobId })).capability,
    "readonly",
  );
});

test("unfinished native audit or placement drift prevents question resumption", async (t) => {
  const f = await fixture(t, { safety: true });
  f.state.audit = "running";
  const d = await f.dispatch();
  const args = { jobId: d.jobId, questionId: d.question.id, text: "A" };
  await assert.rejects(f.hub.answer(args), { code: "source-run-active" });
  assert.equal(
    (await f.hub.questions({ jobId: d.jobId })).questions[0].state,
    "open",
  );
  f.state.audit = "finished";
  await f.hub.changes({ jobId: d.jobId });
  f.state.drift = true;
  await assert.rejects(f.hub.answer(args), { code: "placement-changed" });
  assert.equal(f.state.sends.length, 1);
});

test("stale wait and cancellation cannot create a new question on a superseded request", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch({ maxQuestions: 0 });
  const job = await f.hub.receipt({ jobId: d.jobId });
  job.questionProtocol = { version: 1, maxQuestions: 5 };
  await atomicJson(join(f.home, "jobs", d.jobId + ".json"), job);
  let finish, started;
  const start = new Promise((r) => {
    started = r;
  });
  f.state.wait = (args) => {
    started();
    return new Promise((r) => {
      finish = () => r(completedQuestion(args));
    });
  };
  const waiting = f.hub.operate("wait", { jobId: d.jobId });
  await start;
  const sent = await f.hub.operate("send", {
    jobId: d.jobId,
    text: "follow-up",
  });
  finish();
  assert.equal((await waiting).superseded, true);
  assert.equal((await f.hub.questions({ jobId: d.jobId })).questions.length, 0);
  assert.equal(
    (await f.hub.receipt({ jobId: d.jobId })).requestId,
    sent.requestId,
  );
});

test("a late wait cannot reopen a question after its answer was admitted", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  let finish, started;
  const start = new Promise((r) => {
    started = r;
  });
  f.state.wait = (args) => {
    started();
    return new Promise((r) => {
      finish = () => r(completedQuestion(args));
    });
  };
  const waiting = f.hub.operate("wait", { jobId: d.jobId });
  await start;
  const answered = await f.hub.answer({
    jobId: d.jobId,
    questionId: d.question.id,
    text: "A",
  });
  finish();
  assert.equal((await waiting).superseded, true);
  const record = await f.hub.receipt({ jobId: d.jobId });
  assert.equal(record.questions[0].state, "answered");
  assert.equal(record.requestId, answered.requestId);
});

test("concurrent identical answers cannot enqueue two continuations", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  const args = { jobId: d.jobId, questionId: d.question.id, text: "A" };
  const results = await Promise.allSettled([
    f.hub.answer(args),
    f.hub.answer(args),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  for (const r of results)
    if (r.status === "rejected") assert.equal(r.reason.code, "job-busy");
  assert.equal(f.state.sends.length, 2);
  assert.equal(
    (await f.hub.questions({ jobId: d.jobId })).questions[0].state,
    "answered",
  );
});

test("question remains visible after audit failure; another job cannot answer it", async (t) => {
  const f = await fixture(t, { safety: true });
  f.state.failAudit = true;
  let jobId;
  await assert.rejects(f.dispatch(), (e) => {
    jobId = e.details.jobId;
    return e.code === "run-audit-unconfirmed";
  });
  const pending = await f.hub.questions({ jobId });
  assert.equal(pending.questions[0].state, "open");
  const receipt = await f.hub.receipt({ jobId });
  assert.equal(receipt.backendResult.completed, true);
  await assert.rejects(
    f.hub.answer({ jobId, questionId: pending.questions[0].id, text: "A" }),
    { code: "source-run-active" },
  );
  f.state.failAudit = false;
  const other = await f.dispatch();
  await assert.rejects(
    f.hub.answer({
      jobId: other.jobId,
      questionId: pending.questions[0].id,
      text: "A",
    }),
    { code: "question-not-found" },
  );
});

test("late timeouts cannot erase completed backend evidence for a pending question", async (t) => {
  const f = await fixture(t);
  const d = await f.dispatch();
  f.state.wait = () => ({
    completed: false,
    timedOut: true,
    status: "timed_out_idle",
  });
  const w = await f.hub.operate("wait", { jobId: d.jobId });
  assert.equal(w.status, "needs_input");
  assert.equal(w.question.id, d.question.id);
  assert.equal(
    (await f.hub.receipt({ jobId: d.jobId })).backendResult.completed,
    true,
  );
});
