import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDshAdapter } from "../src/adapters/dsh.mjs";
import { atomicJson } from "../src/core/state.mjs";
test("local/remote share placement protocol; remote paths never become controller paths", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-adapter-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const credentialFile = join(home, "remote.json");
  await atomicJson(credentialFile, {
    version: 1,
    origin: "https://dsh.example.com",
    cookie: "dummy-fixture-cookie",
  });
  for (const kind of ["local", "remote"]) {
    let environment, seen;
    const instance = { id: "dummy-instance", pathStyle: "posix" };
    class DshClient {
      constructor({ env }) {
        environment = env;
        this.baseUrl = new URL(
          kind === "local"
            ? "http://127.0.0.1:12345" // release-check:ignore synthetic target-path fixture
            : "https://dsh.example.com",
        );
        this.localAuth = {
          headers: async () => ({ cookie: "dummy-fixture-cookie" }),
        };
      }
      close() {}
    }
    const adapter = await createDshAdapter(
      {
        name: "test",
        instance,
        connection:
          kind === "local"
            ? { kind, connectionFile: join(home, "local.json") }
            : { kind, baseUrl: "https://dsh.example.com", credentialFile },
      },
      {
        home,
        clientModule: { DshClient },
        fetchImpl: async (url, options) => {
          seen = { url, options };
          return Response.json({
            ok: true,
            value: { protocolVersion: 2, instance },
          });
        },
      },
    );
    await adapter.assertInstance(instance);
    await adapter.prepare({
      jobId: "dummy-job",
      plan: { execution: { requestedCwd: "/remote/tasks/job" } },
    });
    assert.equal(seen.url.pathname, "/plugins/agent-dispatch-hub/v2/control");
    assert.equal(seen.options.redirect, "error");
    assert.equal(
      JSON.parse(seen.options.body).params.plan.execution.requestedCwd,
      "/remote/tasks/job",
    );
    if (kind === "remote") assert.equal(environment.DSH_ALLOW_REMOTE, "true");
    else assert.equal(environment.DSH_ALLOW_REMOTE, undefined);
    await adapter.close();
  }
});
test("endpoint identity mismatch and raw server failures cannot dispatch or expose credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-adapter-errors-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  class DshClient {
    constructor() {
      this.baseUrl = new URL("http://127.0.0.1:12345"); // release-check:ignore synthetic target-path fixture
      this.localAuth = { headers: async () => ({}) };
    }
    close() {}
  }
  let fail = false;
  const adapter = await createDshAdapter(
    {
      name: "test",
      instance: { id: "expected", pathStyle: "posix" },
      connection: { kind: "local", connectionFile: "/dummy/local.json" },
    },
    {
      home,
      clientModule: { DshClient },
      fetchImpl: async () =>
        fail
          ? Response.json(
              {
                ok: false,
                error: {
                  code: "workspace-not-found",
                  message: "secret-cookie-value",
                },
              },
              { status: 400 },
            )
          : Response.json({
              ok: true,
              value: {
                protocolVersion: 2,
                instance: { id: "wrong", pathStyle: "posix" },
              },
            }),
    },
  );
  await assert.rejects(
    adapter.assertInstance({ id: "expected", pathStyle: "posix" }),
    { code: "instance-mismatch" },
  );
  fail = true;
  await assert.rejects(
    adapter.prepare({}),
    (e) =>
      e.code === "workspace-not-found" && !e.message.includes("secret-cookie"),
  );
  await adapter.close();
});

test("prompt RPC preserves the controller request ID and frozen cursor across retries", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-prompt-wire-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  class DshClient {
    constructor() {
      this.localAuth = {};
    }
    getMessages() {
      return { latestSeq: 17 };
    }
    sendMessage() {
      throw Error("Must not mint a request ID in the bridge");
    }
    async rpc(method, payload) {
      calls.push({ method, payload });
      if (calls.length === 1)
        throw Object.assign(Error("dummy lost response"), {
          code: "request-timeout",
        });
      return { accepted: true };
    }
    close() {}
  }
  const adapter = await createDshAdapter(
    {
      name: "test",
      connection: { kind: "local", connectionFile: "/dummy/local.json" },
    },
    { home, clientModule: { DshClient } },
  );
  const cursor = await adapter.cursor({ sessionId: "session-test" });
  const args = {
    sessionId: "session-test",
    requestId: "00000000-0000-4000-8000-000000000001",
    afterSeq: cursor.afterSeq,
    text: "task",
  };
  await assert.rejects(adapter.send(args), { code: "request-timeout" });
  const sent = await adapter.send(args);
  assert.equal(sent.requestId, args.requestId);
  assert.equal(sent.afterSeq, 17);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].method, "session.prompt");
  await adapter.close();
});

test("confirmation observes a logged or queued request and never posts another prompt", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-confirm-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let history = { messages: [] };
  let posts = 0;
  class DshClient {
    getMessages() {
      return history;
    }
    rpc() {
      posts++;
      throw Error("Unexpected prompt POST");
    }
    close() {}
  }
  const adapter = await createDshAdapter(
    {
      name: "test",
      connection: { kind: "local", connectionFile: "/dummy/local.json" },
    },
    { home, clientModule: { DshClient } },
  );
  const args = {
    sessionId: "session-test",
    requestId: "dummy-request",
    afterSeq: 3,
  };
  assert.equal((await adapter.confirmPrompt(args)).accepted, false);
  history = { messages: [{ role: "user", requestId: "dummy-request" }] };
  assert.equal((await adapter.confirmPrompt(args)).accepted, true);
  history = {
    messages: [],
    projections: {
      values: {
        inbox: {
          "next-turn": [{ source: { kind: "user", rpcId: "dummy-request" } }],
        },
      },
    },
  };
  const confirmed = await adapter.confirmPrompt(args);
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.promptSent, false);
  assert.equal(posts, 0);
});
