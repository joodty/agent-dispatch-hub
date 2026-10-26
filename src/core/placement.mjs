import { createHash } from "node:crypto";
import { HubError } from "./state.mjs";
export { planPlacement } from "../../packages/dsh-companion/lib/placement.mjs";

export function digest(value) {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function placementInstructions(context, text) {
  const capability =
    context?.safety?.capability === "readonly"
      ? "This session is permanently readonly: use only native read, glob and grep. Do not write even inside the declared write scope. Do not use shell, MCP actions, subagents or change capability."
      : "Read and write only within the recorded scope.";
  return `Agent Dispatch Hub task placement (directory ranges below are instructions, not a sandbox permission grant):\n${JSON.stringify(context)}\nKeep the recorded actualCwd for this entire task. Source is the recorded source.root; the task cwd is not a source copy or Git worktree. ${capability} Do not broaden permissions or change the model.\n\nTask:\n${text}`;
}
export function assertContext(actual, expected) {
  if (digest(actual) !== digest(expected))
    throw new HubError(
      "placement-changed",
      "The backend placement differs from this job's frozen receipt. No new prompt was sent.",
    );
}
