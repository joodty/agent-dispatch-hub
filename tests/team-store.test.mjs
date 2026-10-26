// Tests for the durable team inbox store.
// Integration target: tests/team-store.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TeamStore } from "../src/team/store.mjs";
import { HubError } from "../src/core/state.mjs";

const HOME_PREFIX = join(tmpdir(), "adh-team-store-");

async function makeHome() {
  const home = await mkdtemp(HOME_PREFIX);
  return home;
}

async function storeFor(home) {
  await mkdir(join(home, "team"), { recursive: true });
  return new TeamStore({ home });
}

test("read returns the empty version 1 state when nothing exists", async () => {
  const home = await makeHome();
  try {
    const store = new TeamStore({ home });
    assert.deepEqual(await store.read(), {
      version: 1,
      projects: {},
      members: {},
      messages: {},
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("transaction persists its mutation and survives a restart", async () => {
  const home = await makeHome();
  try {
    const store = await storeFor(home);
    const returned = await store.transaction((state) => {
      state.projects.alpha = { id: "alpha" };
      state.members.u1 = { id: "u1" };
      state.messages.m1 = { id: "m1", body: "hello" };
      return "ok";
    });
    assert.equal(returned, "ok");

    const stored = JSON.parse(
      await readFile(join(home, "team", "state.json"), "utf8"),
    );
    assert.deepEqual(stored, {
      version: 1,
      projects: { alpha: { id: "alpha" } },
      members: { u1: { id: "u1" } },
      messages: { m1: { id: "m1", body: "hello" } },
    });

    const reopened = new TeamStore({ home });
    assert.deepEqual(await reopened.read(), stored);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a throwing mutator writes nothing and releases the lock", async () => {
  const home = await makeHome();
  try {
    const store = await storeFor(home);
    await store.transaction((state) => {
      state.projects.alpha = { id: "alpha" };
    });
    const before = await readFile(join(home, "team", "state.json"), "utf8");

    await assert.rejects(
      () =>
        store.transaction((state) => {
          state.projects.beta = { id: "beta" };
          throw new Error("boom");
        }),
      /boom/,
    );

    const after = await readFile(join(home, "team", "state.json"), "utf8");
    assert.equal(after, before);
    assert.deepEqual(Object.keys(JSON.parse(after).projects), ["alpha"]);

    await assert.rejects(
      () => readFile(join(home, "team", "state.lock")),
      (error) => error.code === "ENOENT",
    );

    // The lock is usable again after the failure.
    await store.transaction((state) => {
      state.projects.gamma = { id: "gamma" };
    });
    const final = await store.read();
    assert.deepEqual(Object.keys(final.projects).sort(), [
      "alpha",
      "gamma",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a held lock makes a concurrent transaction fail with team-busy", async () => {
  const home = await makeHome();
  try {
    const store = await storeFor(home);
    await writeFile(
      join(home, "team", "state.lock"),
      JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await assert.rejects(
      () =>
        store.transaction((state) => {
          state.projects.blocked = { id: "blocked" };
        }),
      (error) => {
        assert.ok(error instanceof HubError);
        assert.equal(error.code, "team-busy");
        return true;
      },
    );

    // The foreign lock is not reclaimed and no state was written.
    const lock = JSON.parse(
      await readFile(join(home, "team", "state.lock"), "utf8"),
    );
    assert.equal(lock.pid, 999999);
    assert.equal(typeof lock.createdAt, "string");

    await assert.rejects(
      () => readFile(join(home, "team", "state.json")),
      (error) => error.code === "ENOENT",
    );

    // Reads stay lock-free while the lock is held.
    assert.deepEqual(await store.read(), {
      version: 1,
      projects: {},
      members: {},
      messages: {},
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("corrupt or invalid state is rejected without being overwritten", async () => {
  const home = await makeHome();
  try {
    const store = await storeFor(home);
    const path = join(home, "team", "state.json");

    const cases = [
      "{not json",
      JSON.stringify({ version: 2, projects: {}, members: {}, messages: {} }),
      JSON.stringify({ version: 1, projects: [], members: {}, messages: {} }),
      JSON.stringify({ version: 1, projects: {}, members: {}, messages: null }),
      JSON.stringify({ version: "1", projects: {}, members: {}, messages: {} }),
    ];

    for (const body of cases) {
      await writeFile(path, body, "utf8");
      await assert.rejects(
        () => store.read(),
        (error) => {
          assert.ok(error instanceof HubError);
          assert.equal(error.code, "invalid-team-state");
          return true;
        },
      );
      assert.equal(await readFile(path, "utf8"), body);

      await assert.rejects(
        () =>
          store.transaction((state) => {
            state.projects.recovered = { id: "recovered" };
          }),
        (error) => {
          assert.ok(error instanceof HubError);
          assert.equal(error.code, "invalid-team-state");
          return true;
        },
      );
      assert.equal(await readFile(path, "utf8"), body);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("state.json symlinks are rejected and their targets are untouched", async () => {
  const home = await makeHome();
  try {
    const store = await storeFor(home);
    const real = join(home, "real-state.json");
    const body = JSON.stringify({
      version: 1,
      projects: { real: { id: "real" } },
      members: {},
      messages: {},
    });
    await writeFile(real, body, "utf8");
    try {
      await symlink(real, join(home, "team", "state.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code))
        return; // Symlinks unavailable to this account.
      throw error;
    }

    await assert.rejects(
      () => store.read(),
      (error) => {
        assert.ok(error instanceof HubError);
        assert.equal(error.code, "invalid-team-state");
        return true;
      },
    );
    await assert.rejects(
      () =>
        store.transaction((state) => {
          state.projects.viaLink = { id: "viaLink" };
        }),
      (error) => {
        assert.ok(error instanceof HubError);
        assert.equal(error.code, "invalid-team-state");
        return true;
      },
    );
    assert.equal(await readFile(real, "utf8"), body);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("state files over 5 MiB are rejected read-only", async () => {
  const home = await makeHome();
  try {
    const store = await storeFor(home);
    const path = join(home, "team", "state.json");
    const padding = "x".repeat(5 * 1024 * 1024 + 1);
    await writeFile(
      path,
      JSON.stringify({ version: 1, projects: { big: padding }, members: {}, messages: {} }),
      "utf8",
    );
    const before = await readFile(path, "utf8");

    await assert.rejects(
      () => store.read(),
      (error) => {
        assert.ok(error instanceof HubError);
        assert.equal(error.code, "invalid-team-state");
        return true;
      },
    );
    await assert.rejects(
      () =>
        store.transaction((state) => {
          state.projects.small = { id: "small" };
        }),
      (error) => {
        assert.ok(error instanceof HubError);
        assert.equal(error.code, "invalid-team-state");
        return true;
      },
    );
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
