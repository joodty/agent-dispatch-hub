import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { handlerFor } from "../packages/dsh-companion/lib/http.mjs";
import {
  guardManagedDirectories,
  runtimeFor,
} from "../packages/dsh-companion/lib/runtime.mjs";
async function request({
  owner = true,
  method = "POST",
  body,
  service = {
    instance: { id: "instance-test" },
    inspect: async () => ({ protocolVersion: 2 }),
  },
} = {}) {
  const req = Readable.from([JSON.stringify(body ?? { operation: "inspect" })]);
  req.method = method;
  let status, text;
  const res = { writeHead: (s) => (status = s), end: (s) => (text = s) };
  await handlerFor(
    {
      connection: {
        admit: () =>
          owner
            ? { peer: { principal: { kind: "owner" } } }
            : { rejection: 403 },
      },
    },
    service,
  )(req, res);
  return { status, value: JSON.parse(text) };
}
test("companion owner auth and instance check precede any filesystem operation", async () => {
  let called = false;
  const service = {
    instance: { id: "instance-test" },
    prepare: async () => {
      called = true;
    },
  };
  assert.equal(
    (await request({ owner: false, service, body: { operation: "prepare" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await request({
        service,
        body: { operation: "prepare", instanceId: "another" },
      })
    ).value.error.code,
    "instance-mismatch",
  );
  assert.equal(called, false);
  assert.equal((await request({ method: "GET" })).status, 405);
});
test("companion errors expose safe codes and a recoverable session without raw errors", async () => {
  const sessionId = "session-00000000-0000-4000-8000-000000000001";
  const service = {
    instance: { id: "instance-test" },
    prepare: async () => {
      const e = Error("secret-value");
      e.code = "directory-missing";
      e.sessionId = sessionId;
      throw e;
    },
  };
  const response = await request({
    service,
    body: { operation: "prepare", instanceId: "instance-test" },
  });
  assert.deepEqual(response.value.error, {
    code: "directory-missing",
    sessionId,
  });
  assert.ok(!JSON.stringify(response).includes("secret-value"));
});
test("managed cwd guard prevents native fallback and leaves existing sessions alone", async () => {
  let nativeEnsure = 0,
    nativeSet = 0,
    verification = 0,
    missing = false;
  const wd = {
    ensure: async () => {
      nativeEnsure++;
      return "/fallback";
    },
    set: async () => {
      nativeSet++;
      return "/new";
    },
    directory: async (p) => p,
    get: () => "/tasks/job",
  };
  const service = {
    instance: { pathStyle: "posix" },
    records: new Map([
      [
        "job",
        {
          jobId: "job",
          sessionId: "managed",
          context: { execution: { actualCwd: "/tasks/job" } },
        },
      ],
    ]),
    verify: async () => {
      verification++;
      if (missing)
        throw Object.assign(Error("Missing cwd"), {
          code: "directory-missing",
        });
    },
  };
  const restore = guardManagedDirectories(wd, service);
  assert.equal(await wd.ensure({ id: "managed" }), "/tasks/job");
  assert.equal(nativeEnsure, 0);
  assert.equal(await wd.ensure({ id: "existing" }), "/fallback");
  assert.equal(nativeEnsure, 1);
  await assert.rejects(wd.set({ id: "managed" }, "/other"), {
    code: "cwd-change-forbidden",
  });
  assert.equal(nativeSet, 0);
  missing = true;
  await assert.rejects(wd.ensure({ id: "managed" }), {
    code: "directory-missing",
  });
  assert.equal(nativeEnsure, 1);
  restore();
  assert.equal(await wd.ensure({ id: "managed" }), "/fallback");
  assert.equal(verification, 2);
});
test("runtime observes effective projection separately from native header and releases observation", async () => {
  let disposed = false;
  const ctx = {
    workspaceRegistry: { list: () => [], create() {} },
    sessionController: { create() {} },
    agents: { get() {} },
    workingDirectory: { get() {}, set() {}, ensure() {}, directory() {} },
    sessionQuery: {
      observeSession: async () => ({
        header: { cwd: "/group" },
        projections: { values: { workingDirectory: "/group/task" } },
        [Symbol.dispose]: () => (disposed = true),
      }),
    },
  };
  assert.deepEqual(await runtimeFor(ctx).observeSession("session-test"), {
    initialCwd: "/group",
    actualCwd: "/group/task",
  });
  assert.equal(disposed, true);
});
