import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson } from "../src/core/state.mjs";
import { pairTarget } from "../src/core/pair.mjs";
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
