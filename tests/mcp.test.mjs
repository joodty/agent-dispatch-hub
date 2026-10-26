import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.mjs";
import { HubError } from "../src/core/state.mjs";

test("one generic MCP surface routes requests and returns recoverable failures without secrets", async (t) => {
  const hub = {
    targets: async () => ({ targets: [] }),
    status: async () => ({ target: "office", status: { ready: true } }),
    dispatch: async () => {
      throw new HubError("backend-error", "Backend failed.", {
        jobId: "job-recoverable",
        target: "office",
        token: "do-not-print",
      });
    },
  };
  const server = createMcpServer({ hub });
  const client = new Client({ name: "adh-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 13);
  assert.ok(listed.tools.every((tool) => tool.name.startsWith("hub_")));
  assert.equal(
    (
      await client.callTool({
        name: "hub_status",
        arguments: { target: "office" },
      })
    ).structuredContent.target,
    "office",
  );
  const result = await client.callTool({
    name: "hub_dispatch",
    arguments: { target: "office", workspace: "demo", text: "task" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.jobId, "job-recoverable");
  assert.ok(!JSON.stringify(result).includes("do-not-print"));
});
