import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Hub } from "./core/hub.mjs";
import { HubError } from "./core/state.mjs";
import { TeamService } from "./team/service.mjs";
import { TeamScheduler } from "./team/scheduler.mjs";

export function createMcpServer({ home, hub = new Hub({ home }), team }) {
  let teamService;
  const teams = () => team ?? (teamService ??= new TeamService({ home, hub }));
  const server = new McpServer({
    name: "agent-dispatch-hub",
    version: "0.4.0",
  });
  const timeout = z.number().int().min(1000).max(300000).optional();
  const target = z.string().optional();
  const definitions = [
    [
      "hub_team_members",
      "Read configured team projects and members without credentials; no model call.",
      {},
      () => teams().members(),
      true,
    ],
    [
      "hub_message_send",
      "Store an independent question from a configured DSH member/session to its dedicated Codex advisor; no prior Hub job required. Use a stable requestId. A running team scheduler handles it; storing a message alone does not start a model.",
      {
        from: z.string(),
        sessionId: z.string(),
        requestId: z.string().min(1).max(128),
        body: z.object({
          question: z.string().min(1).max(3000),
          context: z.string().max(8000).optional(),
          files: z.array(z.string()).max(10).optional(),
        }),
      },
      (args) => teams().send(args),
      false,
    ],
    [
      "hub_message_receipt",
      "Read an independent message's durable processing and original-session reply admission. delivered means queued, not DSH execution completed.",
      { messageId: z.string() },
      (args) => teams().receipt(args),
      true,
    ],
    [
      "hub_message_run_once",
      "Process one queued advisor request or pending reply within its project budget. May start one dedicated Codex model turn; never contacts a user's active chat.",
      {},
      () => new TeamScheduler({ service: teams() }).tick(),
      false,
    ],
    [
      "hub_message_recover",
      "Reconcile an uncertain advisor turn or DSH reply by original IDs without starting a new model request or resending a reply.",
      { messageId: z.string() },
      (args) => new TeamScheduler({ service: teams() }).recover(args),
      false,
    ],
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
      "Dispatch into a mapped workspace. Retain jobId. A needs_input result is a DSH question: answer it with hub_answer, then hub_wait. A timed out task may still run.",
      {
        target,
        workspace: z.string(),
        text: z.string().min(1),
        timeoutMs: timeout,
        maxQuestions: z.number().int().min(0).max(10).optional(),
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
      "Wait for this job. On needs_input, use hub_answer, then wait again. Retain jobId after a timeout.",
      { jobId: z.string(), timeoutMs: timeout },
      (args) => hub.operate("wait", args),
      true,
    ],
    [
      "hub_questions",
      "Read durable questions and answer admissions for a job. Call hub_wait first to discover new DSH replies. Does not contact or wake a model.",
      { jobId: z.string() },
      (args) => hub.questions(args),
      true,
    ],
    [
      "hub_answer",
      "Answer this job's pending question by questionId and continue its original DSH session. Identical repeats never resend. Handle within existing authority; ask the human for decisions beyond it. Follow with hub_wait.",
      {
        jobId: z.string(),
        questionId: z.string(),
        text: z.string().min(1).max(12000),
      },
      (args) => hub.answer(args),
      false,
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
