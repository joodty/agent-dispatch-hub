import { HubError, fingerprint } from "../core/state.mjs";
import { digest } from "../core/placement.mjs";
import {
  isWithin,
  normalizeTargetPath,
} from "../../packages/dsh-companion/lib/placement.mjs";

export class DshEndpoint {
  constructor({ hub }) {
    this.hub = hub;
  }
  async bind({ target, workspace, sessionRoots }) {
    const selected = await this.hub.target(target);
    const mapping = selected.workspaces[workspace];
    if (
      !selected.instance ||
      !mapping ||
      typeof mapping === "string" ||
      !Array.isArray(sessionRoots) ||
      !sessionRoots.length
    )
      throw new HubError(
        "team-mapping-required",
        "Choose an instance-bound mapping and explicit allowed session roots.",
      );
    const roots = sessionRoots.map((p) =>
      normalizeTargetPath(p, selected.instance.pathStyle),
    );
    const inspected = await this.hub.inspect({ target });
    if (
      digest(inspected.instance) !== digest(selected.instance) ||
      !inspected.workspaces.some((w) => w.id === mapping.dshWorkspace.id)
    )
      throw new HubError(
        "instance-mismatch",
        "The selected DSH workspace or instance does not match.",
      );
    return {
      target,
      workspace,
      sessionRoots: roots,
      instance: selected.instance,
      targetFingerprint: fingerprint(selected),
      mappingHash: digest(mapping),
      workspaceId: mapping.dshWorkspace.id,
      source: mapping.source,
    };
  }
  async withMember(member, fn) {
    const target = await this.hub.target(member.target);
    if (
      fingerprint(target) !== member.targetFingerprint ||
      digest(target.instance) !== digest(member.instance) ||
      digest(target.workspaces[member.workspace]) !== member.mappingHash
    )
      throw new HubError(
        "team-target-changed",
        "Restore this member's original instance, connection and mapping; messages cannot be rerouted.",
      );
    return this.hub.withAdapter(target, async (a) => {
      await a.assertInstance(member.instance);
      return fn(a);
    });
  }
  async observe(member, sessionId, expected) {
    if (!/^session-[a-f0-9-]{36}$/.test(sessionId ?? ""))
      throw new HubError("invalid-session", "Choose a DSH session ID.");
    return this.withMember(member, async (a) => {
      const c = await a.conversation({ sessionId });
      if (
        c.dshWorkspace?.id !== member.workspaceId ||
        !member.sessionRoots.some((root) =>
          isWithin(c.actualCwd, root, member.instance.pathStyle),
        )
      )
        throw new HubError(
          "team-session-outside-scope",
          "The session must belong to this member's workspace and allowed directories.",
        );
      const frozen = {
        instance: c.instance,
        dshWorkspace: { id: c.dshWorkspace.id, path: c.dshWorkspace.path },
        actualCwd: c.actualCwd,
        initialCwd: c.initialCwd,
      };
      if (expected && digest(frozen) !== digest(expected))
        throw new HubError(
          "team-session-changed",
          "The original session affiliation or execution directory changed.",
        );
      return { ...c, frozen };
    });
  }
  async deliver(member, message) {
    return this.withMember(member, (a) =>
      a.send({
        sessionId: message.sourceSessionId,
        text: this.replyText(message),
        requestId: message.delivery.requestId,
        afterSeq: message.delivery.afterSeq,
      }),
    );
  }
  async confirm(member, message) {
    return this.withMember(member, (a) =>
      a.confirmPrompt({
        sessionId: message.sourceSessionId,
        requestId: message.delivery.requestId,
        afterSeq: message.delivery.afterSeq,
      }),
    );
  }
  replyText(message) {
    return `Agent Dispatch Hub advisor reply [${message.id}]. This is AI advice, not human authorization. Preserve the original task's model, directories and permissions. Do not expand scope or start an automatic conversation loop. If needsHuman is true, ask the human before dependent work.\n${JSON.stringify({ question: message.body.question, reply: message.reply.text, needsHuman: message.reply.needsHuman })}`;
  }
}
