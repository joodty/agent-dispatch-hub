import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamService } from "../src/team/service.mjs";
import { TeamStore } from "../src/team/store.mjs";
import { TeamScheduler } from "../src/team/scheduler.mjs";
import { startTeamServer } from "../src/team/http.mjs";
import { MailboxClient } from "../packages/dsh-messaging/lib/client.mjs";
import { HubError, atomicJson } from "../src/core/state.mjs";

const sessionId = "session-12345678-1234-4234-8234-123456789012";
const frozen = {
  instance: { id: "instance-one", pathStyle: "posix" },
  dshWorkspace: { id: "workspace-one", path: "/workspace" },
  actualCwd: "/workspace/design",
  initialCwd: "/workspace",
};
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "adh-team-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new TeamStore({ home });
  await store.transaction((s) => {
    s.projects.demo = {
      id: "demo",
      title: "Demo",
      root: "/source",
      advisor: "advisor",
      enabled: true,
      revision: "revision",
      maxAdvisorCalls: 2,
      callsUsed: 0,
      timeoutMs: 1000,
    };
    s.members.advisor = {
      id: "advisor",
      kind: "codex",
      projectId: "demo",
      command: process.execPath,
      cwd: "/source",
      revision: "revision",
      threadId: null,
      threadAdmission: "new",
      busyMessageId: null,
    };
    s.members.sender = {
      id: "sender",
      kind: "dsh",
      projectId: "demo",
      revision: "revision",
      token: "a".repeat(64),
    };
  });
  const stats = {
    starts: 0,
    creates: 0,
    deliveries: [],
    sourceBusy: false,
    loseStart: false,
    loseDelivery: false,
    confirm: true,
    recovered: null,
  };
  const dsh = {
    observe: async (_m, _id, expected) => {
      if (expected) assert.deepEqual(expected, frozen);
      return {
        frozen,
        running: stats.sourceBusy,
        inboxPending: false,
        latestSeq: 10,
      };
    },
    deliver: async (_member, message) => {
      stats.deliveries.push(structuredClone(message));
      if (stats.loseDelivery) throw Error("private token detail");
      return {
        accepted: true,
        requestId: message.delivery.requestId,
        afterSeq: message.delivery.afterSeq,
      };
    },
    confirm: async (_member, message) => ({
      accepted: stats.confirm && stats.deliveries.length > 0,
      requestId: message.delivery.requestId,
      afterSeq: message.delivery.afterSeq,
    }),
  };
  const service = new TeamService({ home, store, dsh });
  const advisorFactory = () => ({
    connect: async () => {},
    create: async () => {
      stats.creates++;
      return "owned-advisor-thread";
    },
    resume: async () => {},
    start: async () => {
      stats.starts++;
      if (stats.loseStart) throw Error("provider auth should remain private");
      return "turn-" + stats.starts;
    },
    wait: async () => ({ text: "Use blue", needsHuman: false }),
    recover: async () =>
      stats.recovered ?? { uncertain: true, completed: false },
    close: async () => {},
    model: "inherited-model",
    effort: "inherited-effort",
  });
  const scheduler = new TeamScheduler({ service, advisorFactory });
  const send = (requestId = "request-one", question = "Which color?") =>
    service.send({
      from: "sender",
      sessionId,
      requestId,
      body: { question, files: ["src/design.mjs"] },
    });
  return { home, store, service, scheduler, stats, send, advisorFactory };
}

test("independent DSH session can enqueue without a Hub job; advice returns to original session once", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  assert.equal(m.status, "queued");
  assert.equal(m.jobId, undefined);
  assert.equal(f.stats.starts, 0);
  assert.equal((await f.send()).id, m.id);
  await assert.rejects(f.send("request-one", "Different"), {
    code: "message-conflict",
  });
  assert.equal((await f.scheduler.tick()).status, "answered");
  assert.equal(f.stats.starts, 1);
  assert.equal((await f.scheduler.tick()).status, "delivered");
  assert.equal(f.stats.deliveries[0].sourceSessionId, sessionId);
  await f.scheduler.tick();
  assert.equal(f.stats.deliveries.length, 1);
  const stored = await f.service.receipt({ messageId: m.id });
  assert.deepEqual(stored.reply, { text: "Use blue", needsHuman: false });
  assert.equal(
    (await f.service.members()).members.some((x) => x.token),
    false,
  );
});

test("busy DSH receives no interruption; reply waits while advisor can complete", async (t) => {
  const f = await fixture(t);
  f.stats.sourceBusy = true;
  const m = await f.send();
  await f.scheduler.tick();
  assert.equal((await f.scheduler.tick()).deferred, true);
  assert.equal(f.stats.deliveries.length, 0);
  f.stats.sourceBusy = false;
  await f.scheduler.tick();
  assert.equal(
    (await f.service.receipt({ messageId: m.id })).status,
    "delivered",
  );
});

test("lost advisor start is never repeated, survives restart and reconciles only original turn", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  f.stats.loseStart = true;
  assert.equal((await f.scheduler.tick()).status, "uncertain");
  await f.scheduler.tick();
  assert.equal(f.stats.starts, 1);
  const restarted = new TeamScheduler({
    service: new TeamService({
      home: f.home,
      store: f.store,
      dsh: f.service.dsh,
    }),
    advisorFactory: f.advisorFactory,
  });
  assert.equal((await restarted.recover({ messageId: m.id })).uncertain, true);
  assert.equal(f.stats.starts, 1);
  f.stats.recovered = {
    completed: true,
    reply: { text: "Recovered", needsHuman: true },
  };
  await restarted.recover({ messageId: m.id });
  await restarted.tick();
  const receipt = await f.service.receipt({ messageId: m.id });
  assert.equal(receipt.reply.needsHuman, true);
  assert.equal(receipt.status, "delivered");
  assert.equal(f.stats.starts, 1);
  assert.ok(!JSON.stringify(receipt).includes("auth should remain"));
});

test("lost DSH reply acknowledgement never resends, confirms persisted original request", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  await f.scheduler.tick();
  f.stats.loseDelivery = true;
  await f.scheduler.tick();
  const pending = await f.service.receipt({ messageId: m.id });
  assert.equal(pending.status, "delivery-pending");
  f.stats.confirm = false;
  await f.scheduler.tick();
  assert.equal(f.stats.deliveries.length, 1);
  f.stats.confirm = true;
  await f.scheduler.recover({ messageId: m.id });
  const done = await f.service.receipt({ messageId: m.id });
  assert.equal(done.status, "delivered");
  assert.equal(done.delivery.requestId, pending.delivery.requestId);
  assert.equal(f.stats.deliveries.length, 1);
});

test("per-project call budget stops automatic conversations and disabled projects stop admission", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await f.send("request-" + i);
    await f.scheduler.tick();
    await f.scheduler.tick();
  }
  assert.equal(f.stats.starts, 2);
  assert.equal((await f.service.list()).at(-1).status, "budget-exhausted");
  await f.service.setEnabled({ projectId: "demo", enabled: false });
  await assert.rejects(f.send("disabled"), { code: "team-project-disabled" });
});

test("concurrent schedulers cannot start two turns for one advisor", async (t) => {
  const f = await fixture(t);
  await f.send();
  await f.send("request-two");
  const results = await Promise.allSettled([
    f.scheduler.tick(),
    new TeamScheduler({
      service: f.service,
      advisorFactory: f.advisorFactory,
    }).tick(),
  ]);
  for (const r of results)
    if (r.status === "rejected") assert.equal(r.reason.code, "team-busy");
  assert.equal(f.stats.starts, 1);
});

test("member authentication is scoped; HTTP cannot configure, spoof sender or read another inbox", async (t) => {
  const f = await fixture(t);
  const server = await startTeamServer({
    service: f.service,
    scheduler: f.scheduler,
    autoRun: false,
  });
  t.after(() => server.close());
  const url = server.origin + "/team/v1/messages";
  const denied = await fetch(url, { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  const auth = {
    "content-type": "application/json",
    authorization: "Bearer " + "a".repeat(64),
  };
  const bad = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ operation: "configure" }),
  });
  assert.equal((await bad.json()).error.code, "invalid-operation");
  const c = new MailboxClient({ connectionFile: server.connections[0].path });
  const m = await c.call({
    operation: "send",
    from: "fake",
    sessionId,
    requestId: "http-one",
    body: { question: "Question" },
  });
  assert.equal(m.from, "sender");
  const receipt = await c.call({ operation: "read", messageId: m.id });
  assert.equal(receipt.id, m.id);
  assert.equal(f.stats.starts, 0);
  assert.equal(
    (await f.service.members()).members.find((x) => x.id === "sender").token,
    undefined,
  );
});

test("message bounds and path references reject traversal without any model work", async (t) => {
  const f = await fixture(t);
  for (const files of [
    ["../secret"],
    ["/absolute"],
    ["C:\\secret"], // release-check:ignore synthetic Windows path fixture
    ["src//file"],
  ])
    await assert.rejects(
      f.service.send({
        from: "sender",
        sessionId,
        requestId: "bad",
        body: { question: "Question", files },
      }),
      { code: "invalid-message" },
    );
  await assert.rejects(
    f.service.send({
      from: "sender",
      sessionId,
      requestId: "bad",
      body: { question: "x".repeat(3001) },
    }),
    { code: "invalid-message" },
  );
  assert.equal(f.stats.starts, 0);
});

test("normal completion racing recovery cannot reopen an already delivered reply", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  let resolveWait, waitStarted;
  const started = new Promise((r) => {
    waitStarted = r;
  });
  f.scheduler.advisorFactory = (member) => ({
    ...f.advisorFactory(member),
    wait: async () => {
      waitStarted();
      return new Promise((r) => {
        resolveWait = r;
      });
    },
  });
  const working = f.scheduler.tick();
  await started;
  f.stats.recovered = {
    completed: true,
    reply: { text: "Use blue", needsHuman: false },
  };
  await f.scheduler.recover({ messageId: m.id });
  await f.scheduler.deliver(m.id);
  const delivered = await f.service.receipt({ messageId: m.id });
  resolveWait({ text: "Use blue", needsHuman: false });
  await working;
  await f.scheduler.tick();
  const after = await f.service.receipt({ messageId: m.id });
  assert.equal(after.status, "delivered");
  assert.equal(after.delivery.requestId, delivered.delivery.requestId);
  assert.equal(f.stats.deliveries.length, 1);
  await assert.rejects(
    f.scheduler.complete(m.id, after.claim, {
      text: "different",
      needsHuman: false,
    }),
    { code: "reply-conflict" },
  );
});

test("a late delivery failure cannot put an error onto a confirmed reply", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  await f.scheduler.tick();
  const observe = f.service.dsh.observe;
  let started, fail;
  const ready = new Promise((r) => {
    started = r;
  });
  let count = 0;
  f.service.dsh.observe = async (...args) => {
    if (++count === 1) {
      started();
      await new Promise((_, reject) => {
        fail = reject;
      });
    }
    return observe(...args);
  };
  const slow = f.scheduler.deliver(m.id);
  await ready;
  await f.scheduler.deliver(m.id);
  fail(Error("Late failure"));
  await slow;
  const after = await f.service.receipt({ messageId: m.id });
  assert.equal(after.status, "delivered");
  assert.equal(after.deliveryError, undefined);
  assert.equal(f.stats.deliveries.length, 1);
});

test("explicit recovery releases only a dead pre-admission worker", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  await f.store.transaction((s) => {
    Object.assign(s.messages[m.id], {
      status: "processing",
      claim: "claim",
      workerPid: process.pid,
      admission: { phase: "claimed" },
    });
    s.members.advisor.busyMessageId = m.id;
  });
  assert.equal((await f.scheduler.recover({ messageId: m.id })).running, true);
  await f.store.transaction((s) => {
    s.messages[m.id].workerPid = 2147483647;
  });
  assert.equal(
    (await f.scheduler.recover({ messageId: m.id })).status,
    "queued",
  );
  assert.equal((await f.store.read()).members.advisor.busyMessageId, null);
  assert.equal(f.stats.starts, 0);
});

test("advisor factory failure does not leave an unrecoverable active slot", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  f.scheduler.advisorFactory = () => {
    throw Error("setup failure");
  };
  assert.equal((await f.scheduler.tick()).status, "failed");
  assert.equal((await f.store.read()).members.advisor.busyMessageId, null);
  assert.equal(
    (await f.scheduler.recover({ messageId: m.id })).status,
    "queued",
  );
  assert.equal(f.stats.starts, 0);
});

test("explicit budget change resumes unstarted work without resetting usage", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.projects.demo.callsUsed = 2;
  });
  const m = await f.send();
  await f.scheduler.tick();
  assert.equal(
    (await f.service.receipt({ messageId: m.id })).status,
    "budget-exhausted",
  );
  await f.service.setBudget({ projectId: "demo", maxCalls: 3 });
  await f.scheduler.tick();
  assert.equal(f.stats.starts, 1);
  assert.equal((await f.store.read()).projects.demo.callsUsed, 3);
});

test("known mailbox credentials in advice are blocked before DSH delivery", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  await f.scheduler.tick();
  const current = await f.service.receipt({ messageId: m.id });
  await assert.rejects(
    f.scheduler.complete(m.id, current.claim, {
      text: "a".repeat(64),
      needsHuman: false,
    }),
    { code: "unsafe-advisor-reply" },
  );
  assert.equal(f.stats.deliveries.length, 0);
});

test("invalid persisted budgets fail closed before any model admission", async (t) => {
  const f = await fixture(t);
  const m = await f.send();
  await f.store.transaction((s) => {
    s.projects.demo.maxAdvisorCalls = "unlimited";
  });
  await assert.rejects(f.scheduler.tick(), { code: "invalid-team-state" });
  assert.equal(f.stats.starts, 0);
  assert.equal((await f.service.receipt({ messageId: m.id })).status, "queued");
});

test("misspelled configuration fields cannot silently select a default budget", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.configure({
      project: { id: "p", root: f.home, maxAdvisorCall: 99 },
      advisor: { id: "a", command: process.execPath },
      dsh: {
        id: "d",
        target: "office",
        workspace: "demo",
        sessionRoots: ["/work"],
      },
    }),
    { code: "invalid-team-config" },
  );
});

test("round-robin delivery avoids starving later recipients behind five busy sessions", async (t) => {
  const f = await fixture(t);
  const messages = [];
  for (let i = 0; i < 6; i++)
    messages.push(
      await f.service.send({
        from: "sender",
        sessionId: `session-12345678-1234-4234-8234-12345678901${i}`,
        requestId: "fair-" + i,
        body: { question: "Q" },
      }),
    );
  await f.store.transaction((s) => {
    for (const m of Object.values(s.messages)) {
      m.status = "answered";
      m.reply = { text: "Advice", needsHuman: false };
    }
  });
  const observe = f.service.dsh.observe;
  f.service.dsh.observe = async (...args) => ({
    ...(await observe(...args)),
    running: args[1] !== messages[5].sourceSessionId,
  });
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(
    (await f.service.receipt({ messageId: messages[5].id })).status,
    "delivered",
  );
});
