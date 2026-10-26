#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stateHome } from "../src/core/state.mjs";

let client;
try {
  const { values, positionals } = parseArgs({
    options: { home: { type: "string" } },
    allowPositionals: true,
  });
  const [name, file] = positionals;
  if (!name || positionals.length > 2 || !/^hub_[a-z_]+$/.test(name))
    throw Error("Invalid arguments");
  const args = file ? JSON.parse(await readFile(file, "utf8")) : {};
  client = new Client({
    name: "agent-dispatch-hub-cli-fallback",
    version: "0.2.1",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../bin/adh.mjs", import.meta.url)),
        "mcp",
        "--home",
        stateHome(values.home),
      ],
      stderr: "pipe",
    }),
  );
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === name))
    throw Error("Unknown tool");
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 330000,
  });
  console.log(
    JSON.stringify({ transport: "mcp-stdio", tool: name, result }, null, 2),
  );
  if (result.isError) process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      ok: false,
      error: {
        code: "mcp-call-failed",
        message:
          "Use: node scripts/call-tool.mjs hub_<tool> [arguments.json] [--home state-directory]. Check target readiness and argument schema; inputs are not echoed.",
      },
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.close();
}
