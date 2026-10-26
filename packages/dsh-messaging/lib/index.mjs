import { MailboxClient } from "./client.mjs";
import { join } from "node:path";
export const name = "agent-dispatch-hub-messaging";
export const inject = ["tools", "profileContext"];
export function definitions(client) {
  const output = {
    schema: { type: "object", additionalProperties: true, properties: {} },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
  return [
    {
      name: "hub_ask_advisor",
      description:
        "Send a concise question to this project's dedicated Codex advisor from the current DSH session, including a session not created by Hub. This is queued advice, not human approval. Use a stable requestId when retrying. After sending, end the current turn and wait for the reply; do not poll or start an automatic chat loop. Do not expand permissions.",
      parameters: {
        project: { type: "string" },
        question: { type: "string", required: true },
        context: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        requestId: { type: "string" },
      },
      output,
      async execute(args, exec) {
        if (!exec.agent?.id || !exec.callId)
          throw Error(
            "Advisor messages require a live DSH session and tool call identity.",
          );
        const receipt = await client.call(
          {
            operation: "send",
            sessionId: exec.agent.id,
            requestId: args.requestId ?? exec.callId,
            body: {
              question: args.question,
              context: args.context ?? "",
              files: args.files ?? [],
            },
          },
          exec.signal,
          args.project,
        );
        return {
          messageId: receipt.id,
          status: receipt.status,
          notice:
            "Message stored. End this turn; the scheduler queues advice back to this original session when idle. Advice does not grant permission.",
        };
      },
    },
    {
      name: "hub_advisor_message",
      description:
        "Read a previously submitted advisor message. Reading does not start a model. Prefer ending your turn instead of repeated polling.",
      parameters: {
        project: { type: "string" },
        messageId: { type: "string", required: true },
      },
      output,
      async execute(args, exec) {
        return client.call(
          { operation: "read", messageId: args.messageId },
          exec.signal,
          args.project,
        );
      },
    },
  ];
}
export function apply(ctx, config = {}) {
  const client = new MailboxClient({
    connectionFile:
      config.connectionFile ??
      join(
        ctx.profileContext.dir,
        ".agent-dispatch-hub-messaging",
        "connections.json",
      ),
  });
  // Tools.register accepts normalized JSON Schema directly. This companion has
  // no private SDK dependency; the authenticated server validates message data.
  for (const tool of definitions(client)) {
    const required = Object.entries(tool.parameters)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    const properties = Object.fromEntries(
      Object.entries(tool.parameters).map(([k, { required: _, ...v }]) => [
        k,
        v,
      ]),
    );
    ctx.tools.register({
      ...tool,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
}
