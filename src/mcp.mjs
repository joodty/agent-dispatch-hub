import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Hub } from "./core/hub.mjs";
import { HubError } from "./core/state.mjs";

export function createMcpServer({ home, hub = new Hub({ home }) }) {
  const server = new McpServer({
    name: "agent-dispatch-hub",
    version: "0.2.0",
  });
  const timeout = z.number().int().min(1000).max(300000).optional();
  const target = z.string().optional();
  const definitions = [
    [
      "hub_recover",
      "Recover an uncertain placement using the original job ID and frozen plan; sends no model prompt",
      { jobId: z.string() },
      (args) => hub.recover(args),
      false,
    ],
    [
      "hub_retry",
      "Confirm an uncertain prompt from its original request ID and exact text; never resend",
      { jobId: z.string(), text: z.string().min(1) },
      (args) => hub.retryPrompt(args),
      false,
    ],
    [
      "hub_receipt",
      "Read the durable receipt and retained backend completion evidence without changing a task",
      { jobId: z.string() },
      (args) => hub.receipt(args),
      true,
    ],
    [
      "hub_inspect",
      "Read the explicitly selected instance identity and DSH workspace directory mapping",
      { target },
      (args) => hub.inspect(args),
      true,
    ],
    [
      "hub_verify",
      "Verify a job's frozen instance, DSH workspace membership and effective task cwd",
      { jobId: z.string() },
      (args) => hub.verify(args),
      true,
    ],
    [
      "hub_artifact",
      "Read a relative artifact inside the job's frozen cwd and declared read scope",
      { jobId: z.string(), path: z.string().min(1) },
      (args) => hub.readArtifact(args),
      true,
    ],
    [
      "hub_targets",
      "List configured targets and workspace names",
      {},
      () => hub.targets(),
      true,
    ],
    [
      "hub_status",
      "Check the selected execution backend and model",
      { target },
      (args) => hub.status(args),
      true,
    ],
    [
      "hub_dispatch",
      "Dispatch into a mapped workspace. Return and retain jobId for follow-ups. A timed out task may still run.",
      {
        target,
        workspace: z.string(),
        text: z.string().min(1),
        timeoutMs: timeout,
      },
      (args) => hub.dispatch(args),
      false,
    ],
    [
      "hub_send",
      "Send a follow-up to the original job target",
      { jobId: z.string(), text: z.string().min(1) },
      (args) => hub.operate("send", args),
      false,
    ],
    [
      "hub_wait",
      "Wait for the request belonging to this job; retain jobId after a timeout",
      { jobId: z.string(), timeoutMs: timeout },
      (args) => hub.operate("wait", args),
      true,
    ],
    [
      "hub_messages",
      "Read replies from the original job target",
      { jobId: z.string() },
      (args) => hub.operate("messages", args),
      true,
    ],
    [
      "hub_cancel",
      "Request cancellation on the original job target",
      { jobId: z.string() },
      (args) => hub.operate("cancel", args),
      false,
    ],
  ];
  for (const [name, description, inputSchema, call, readOnly] of definitions)
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: name === "hub_cancel",
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          const value = await call(args);
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (error) {
          const details = Object.fromEntries(
            ["jobId", "target", "sessionId"]
              .filter((key) => typeof error.details?.[key] === "string")
              .map((key) => [key, error.details[key]]),
          );
          const value = {
            ok: false,
            error: {
              code: error instanceof HubError ? error.code : "operation-failed",
              message:
                error instanceof HubError
                  ? error.message
                  : "Hub operation failed. Check the target configuration and backend readiness.",
              ...details,
            },
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
        }
      },
    );
  return server;
}
export async function startMcp(home) {
  const server = createMcpServer({ home });
  await server.connect(new StdioServerTransport());
}
