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
