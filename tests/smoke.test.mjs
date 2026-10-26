import assert from "node:assert/strict";
import test from "node:test";
import { smoke } from "../src/core/smoke.mjs";
test("remote smoke verifies backend bytes rather than trusting a completion claim", async () => {
  let nonce;
  const selected = { name: "home", connection: { kind: "remote" } };
  const hub = {
    target: async () => selected,
    dispatch: async (args) => {
      nonce = args.text.match(/nonce exactly "([^"]+)"/)[1];
      return { jobId: "job-test", completed: true, sessionId: "s" };
    },
    resolveJob: async () => ({
      job: { id: "job-test", sessionId: "s", target: "home" },
      selected,
    }),
    withAdapter: async (_target, fn) =>
      fn({
        readArtifact: async () => ({
          text: JSON.stringify({ nonce, product: 1591 }),
          eof: true,
        }),
      }),
  };
  const result = await smoke(hub, { workspace: "demo" });
  assert.equal(result.verification.passed, true);
  hub.withAdapter = async (_target, fn) =>
    fn({
      readArtifact: async () => ({
        text: JSON.stringify({ nonce, product: 0 }),
        eof: true,
      }),
    });
  await assert.rejects(smoke(hub, { workspace: "demo" }), {
    code: "smoke-failed",
  });
});
