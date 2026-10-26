import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson } from "../src/core/state.mjs";
import { pairTarget } from "../src/core/pair.mjs";
import { readJson } from "../src/core/state.mjs";
test("pairing refuses a different host before making any request", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-pair-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, "config.json"), {
    version: 1,
    targets: {
      home: {
        adapter: "dsh",
        connection: {
          kind: "remote",
          baseUrl: "https://home.example",
          credentialFile: join(home, "credentials", "home.json"),
        },
        workspaces: { demo: "/project" },
      },
    },
  });
  let called = false;
  await assert.rejects(
    pairTarget(home, "home", "https://other.example/?token=" + "a".repeat(43), {
      fetchImpl: () => {
        called = true;
      },
    }),
    { code: "pairing-origin-mismatch" },
  );
  assert.equal(called, false);
});
test("pairing stores a same-origin cookie privately and rejects cross-origin redirect", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-pair-positive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "credentials", "home.json");
  await atomicJson(join(home, "config.json"), {
    version: 1,
    targets: {
      home: {
        adapter: "dsh",
        connection: {
          kind: "remote",
          baseUrl: "https://home.example",
          credentialFile: path,
        },
        workspaces: { demo: "/project" },
      },
    },
  });
  let seen;
  const result = await pairTarget(
    home,
    "home",
    "https://home.example/?token=" + "a".repeat(43),
    {
      fetchImpl: async (url, options) => {
        seen = { origin: url.origin, redirect: options.redirect };
        return new Response(null, {
          status: 302,
          headers: {
            location: "./",
            "set-cookie":
              "dsh_dummy_cookie=test-fixture-value; HttpOnly; Secure; SameSite=Strict",
          },
        });
      },
    },
  );
  assert.equal(result.paired, true);
  assert.deepEqual(seen, {
    origin: "https://home.example",
    redirect: "manual",
  });
  const saved = await readJson(path);
  assert.equal(saved.origin, "https://home.example");
  assert.equal(saved.cookie, "dsh_dummy_cookie=test-fixture-value");
  assert.ok(!JSON.stringify(result).includes(saved.cookie));
  await assert.rejects(
    pairTarget(home, "home", "https://home.example/?token=" + "b".repeat(43), {
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://other.example/",
            "set-cookie": "dsh_dummy_cookie=other",
          },
        }),
    }),
    { code: "pairing-failed" },
  );
  assert.equal((await readJson(path)).cookie, saved.cookie);
});
