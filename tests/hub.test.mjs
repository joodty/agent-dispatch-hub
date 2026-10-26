import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, AdapterRegistry } from "../src/core/hub.mjs";
import { atomicJson, loadConfig } from "../src/core/state.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "adh-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, "config.json"), {
    version: 1,
    defaultTarget: "office",
    targets: {
      office: {
        adapter: "fake",
        connection: { kind: "local", connectionFile: "/office" },
        workspaces: { demo: "/office/project" },
      },
      home: {
        adapter: "fake",
        connection: { kind: "remote", baseUrl: "https://example.com" },
        workspaces: { demo: "/remote/project" },
      },
    },
  });
  return home;
}
test("target switch cannot reroute an existing job; remote workspace remains remote", async (t) => {
  const home = await fixture(t),
    calls = [];
  const registry = new AdapterRegistry().register("fake", (target) => ({
    dispatch: async (args) => {
      calls.push([target.name, args.cwd]);
      await args.onAdmitted({ sessionId: "s", requestId: "r", afterSeq: 2 });
      return {
        sessionId: "s",
        requestId: "r",
        afterSeq: 2,
        status: "timed_out_running",
      };
    },
    wait: async (args) => {
      calls.push([target.name, args.sessionId, args.requestId]);
      return { status: "completed" };
    },
    close() {},
  }));
  const hub = new Hub({ home, registry });
  const job = await hub.dispatch({ workspace: "demo", text: "task" });
  const config = await loadConfig(home);
  config.defaultTarget = "home";
  await atomicJson(join(home, "config.json"), config);
  await hub.operate("wait", { jobId: job.jobId });
  const remote = await hub.dispatch({ workspace: "demo", text: "remote task" });
  assert.deepEqual(calls, [
    ["office", "/office/project"],
    ["office", "s", "r"],
    ["home", "/remote/project"],
  ]);
  assert.equal(remote.target, "home");
});
test("changed endpoint rejects old job before backend contact", async (t) => {
  const home = await fixture(t);
  let calls = 0;
  const hub = new Hub({
    home,
    registry: new AdapterRegistry().register("fake", () => ({
      dispatch: async () => ({ sessionId: "s", status: "completed" }),
      wait: async () => {
        calls++;
      },
      close() {},
    })),
  });
  const job = await hub.dispatch({ workspace: "demo", text: "task" });
  const config = await loadConfig(home);
  config.targets.office.connection.connectionFile = "/another-instance";
  await atomicJson(join(home, "config.json"), config);
  await assert.rejects(hub.operate("wait", { jobId: job.jobId }), {
    code: "target-changed",
  });
  assert.equal(calls, 0);
});
test("admitted session survives later backend failure without leaking its error", async (t) => {
  const home = await fixture(t);
  const hub = new Hub({
    home,
    registry: new AdapterRegistry().register("fake", () => ({
      dispatch: async (args) => {
        await args.onAdmitted({
          sessionId: "recoverable-session",
          requestId: "request-1",
        });
        throw Error("secret-token-value");
      },
      close() {},
    })),
  });
  await assert.rejects(
    hub.dispatch({ workspace: "demo", text: "task" }),
    (error) =>
      error.code === "backend-error" && !error.message.includes("secret"),
  );
  const { readdir } = await import("node:fs/promises");
  const [file] = await readdir(join(home, "jobs"));
  const job = JSON.parse(await readFile(join(home, "jobs", file), "utf8"));
  assert.equal(job.sessionId, "recoverable-session");
  assert.ok(!JSON.stringify(job).includes("secret-token-value"));
});
test("missing workspace and traversal job ID fail before adapter creation", async (t) => {
  const home = await fixture(t);
  let calls = 0;
  const hub = new Hub({
    home,
    registry: new AdapterRegistry().register("fake", () => {
      calls++;
    }),
  });
  await assert.rejects(hub.dispatch({ text: "task", workspace: "unknown" }), {
    code: "workspace-required",
  });
  await assert.rejects(hub.operate("wait", { jobId: "../credentials/home" }), {
    code: "invalid-job",
  });
  assert.equal(calls, 0);
});
test("a previous wait cannot overwrite a concurrent follow-up or block cancellation", async (t) => {
  const home = await fixture(t);
  let finishWait, waitStarted;
  const started = new Promise((r) => (waitStarted = r));
  const hub = new Hub({
    home,
    registry: new AdapterRegistry().register("fake", () => ({
      dispatch: async () => ({
        sessionId: "s",
        requestId: "r1",
        afterSeq: 2,
        status: "timed_out_running",
      }),
      wait: async () => {
        waitStarted();
        return new Promise((r) => (finishWait = r));
      },
      send: async () => ({ requestId: "r2", afterSeq: 10, accepted: true }),
      cancel: async () => ({ accepted: true }),
      close() {},
    })),
  });
  const first = await hub.dispatch({ workspace: "demo", text: "first" });
  const waiting = hub.operate("wait", { jobId: first.jobId });
  await started;
  await hub.operate("send", { jobId: first.jobId, text: "next" });
  await hub.operate("cancel", { jobId: first.jobId });
  finishWait({ requestId: "r1", status: "completed", completed: true });
  assert.equal((await waiting).superseded, true);
  const { job } = await hub.resolveJob(first.jobId);
  assert.equal(job.requestId, "r2");
  assert.equal(job.state, "cancellation-requested");
});
