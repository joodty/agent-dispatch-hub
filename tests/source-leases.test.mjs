import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { SourceLeaseStore } from "../packages/dsh-companion/lib/source-leases.mjs";
const moduleUrl = new URL(
  "../packages/dsh-companion/lib/source-leases.mjs",
  import.meta.url,
).href;
function lease(roots, mode = "write") {
  const requestId = randomUUID();
  return {
    runId: "run-" + requestId,
    requestId,
    jobId: "job-" + randomUUID(),
    sessionId: "session-" + randomUUID(),
    roots,
    mode,
  };
}
async function fixture(t, pathStyle = "posix") {
  const directory = await mkdtemp(path.join(tmpdir(), "adh-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { directory, instanceId: "test-instance", pathStyle };
  return { config, store: new SourceLeaseStore(config) };
}
test("overlapping roots exclude coding while readonly leases share and sibling path prefixes remain independent", async (t) => {
  const { store } = await fixture(t),
    a = lease(["/work/source"], "read"),
    b = lease(["/work/source/sub"], "read");
  await store.acquire(a);
  await store.acquire(b);
  await assert.rejects(store.acquire(lease(["/work/source"])), {
    code: "source-locked",
  });
  await assert.rejects(store.acquire(lease(["/work"])), {
    code: "source-locked",
  });
  await store.acquire(lease(["/work/source-other"]));
  assert.equal((await store.list()).length, 3);
  await store.release(a);
  await store.release(b);
  await store.acquire(lease(["/work/source"]));
});
test("Windows path aliases, case and drive roots use target semantics; unsupported UNC roots fail explicitly", async (t) => {
  const { store } = await fixture(t, "win32");
  await store.acquire(lease(["C:/work/repo"]));
  await assert.rejects(store.acquire(lease(["c:\\work\\REPO\\child"])), {
    code: "source-locked",
  });
  await store.acquire(lease(["C:/work/repository"]));
  await assert.rejects(store.acquire(lease(["C:/"])), {
    code: "source-locked",
  });
  assert.throws(() => store.acquire(lease(["//server/share/project"])), {
    code: "invalid-lease-roots",
  });
});
test("leases survive store restart; exact identity is idempotent and another owner cannot release it", async (t) => {
  const { store, config } = await fixture(t),
    a = lease(["/repo"]);
  await store.acquire(a);
  const restarted = new SourceLeaseStore(config);
  assert.equal((await restarted.list()).length, 1);
  await restarted.acquire(a);
  await assert.rejects(restarted.acquire({ ...a, roots: ["/elsewhere"] }), {
    code: "lease-owner-conflict",
  });
  await assert.rejects(
    restarted.release({ ...a, jobId: "job-" + randomUUID() }),
    { code: "lease-owner-conflict" },
  );
  assert.equal((await restarted.list()).length, 1);
  await restarted.release(a);
  assert.equal((await restarted.list()).length, 0);
});
test("cross-process acquisition serializes the durable table and admits exactly one overlapping writer", async (t) => {
  const { config, store } = await fixture(t);
  const run = async (a) => {
    const code = `import{SourceLeaseStore}from ${JSON.stringify(moduleUrl)};try{await new SourceLeaseStore(${JSON.stringify(config)}).acquire(${JSON.stringify(a)});console.log('admitted')}catch(e){console.log(e.code)}`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
      windowsHide: true,
    });
    let out = "";
    p.stdout.on("data", (x) => (out += x));
    await new Promise((r, j) => {
      p.on("error", j);
      p.on("exit", (c) => (c ? j(Error("child failed")) : r()));
    });
    return out.trim();
  };
  assert.deepEqual(
    (
      await Promise.all([run(lease(["/repo"])), run(lease(["/repo/sub"]))])
    ).sort(),
    ["admitted", "source-locked"],
  );
  assert.equal((await store.list()).length, 1);
});
test("corrupt or cross-instance state and abandoned transaction locks fail closed", async (t) => {
  const { store, config } = await fixture(t);
  await store.acquire(lease(["/repo"]));
  await assert.rejects(
    new SourceLeaseStore({ ...config, instanceId: "another" }).list(),
    { code: "invalid-lease-state" },
  );
  await writeFile(path.join(config.directory, "leases.json"), "broken");
  await assert.rejects(store.list(), { code: "invalid-lease-state" });
  await mkdir(path.join(config.directory, "transaction.lock"));
  await assert.rejects(store.list(), { code: "lease-store-busy" });
});
