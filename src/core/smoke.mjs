import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HubError } from "./state.mjs";

export async function smoke(
  hub,
  { target, workspace, timeoutMs = 55000 } = {},
) {
  const selected = await hub.target(target);
  const nonce = randomUUID();
  const artifact = `adh-smoke-${nonce}/result.json`;
  const text = `Agent Dispatch Hub integration acceptance. Work only in the current workspace. Do not read outside it, use the network, or create subagents. Use your file tool to create only ${artifact}, making its new parent directory as needed. Write valid JSON with nonce exactly "${nonce}" and product as the numeric value of 37 multiplied by 43. Read the file back with your tools, then report the relative file path and completion. The controller will independently read that exact file through the authenticated backend API and verify it. Do not create any other files.`;
  const result = await hub.dispatch({
    target: selected.name,
    workspace,
    text,
    timeoutMs,
  });
  if (!result.completed)
    return {
      ...result,
      artifact,
      verification: { passed: false, pending: true },
    };
  const { job, selected: original } = await hub.resolveJob(result.jobId);
  const page = await hub.withAdapter(original, (a) => {
    if (typeof a.readArtifact !== "function")
      throw new HubError(
        "verification-unsupported",
        "This adapter does not support independent artifact reads.",
      );
    return a.readArtifact({ sessionId: job.sessionId, path: artifact });
  });
  let value;
  try {
    value = JSON.parse(page.text.replace(/^\uFEFF/, ""));
  } catch {
    throw new HubError(
      "smoke-failed",
      "The backend artifact is not a valid JSON document.",
      { jobId: job.id, target: job.target },
    );
  }
  if (page.eof !== true || value.nonce !== nonce || value.product !== 1591)
    throw new HubError(
      "smoke-failed",
      "The backend artifact failed nonce, arithmetic or completeness verification.",
      { jobId: job.id, target: job.target },
    );
  let localFileVerified;
  if (original.connection.kind === "local") {
    const local = JSON.parse(
      (await readFile(join(job.cwd, artifact), "utf8")).replace(/^\uFEFF/, ""),
    );
    if (local.nonce !== nonce || local.product !== 1591)
      throw new HubError(
        "smoke-failed",
        "The local file does not match the backend artifact.",
        { jobId: job.id, target: job.target },
      );
    localFileVerified = true;
  }
  return {
    ...result,
    artifact,
    verification: {
      passed: true,
      method: "authenticated-backend-file-read",
      localFileVerified,
      value,
    },
  };
}
