import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TeamStore } from "./store.mjs";
import { Hub } from "../core/hub.mjs";
import { HubError, validName, privateDirectory } from "../core/state.mjs";
import { digest } from "../core/placement.mjs";
import { DshEndpoint } from "./dsh-endpoint.mjs";

const fail = (code, message) => {
  throw new HubError(code, message);
};
const name = (v) => {
  validName(v, "team identity");
  if (["__proto__", "constructor", "prototype"].includes(v))
    fail("invalid-name", "Reserved team identity.");
  return v;
};
function text(v, max, required = false) {
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    fail("invalid-message", "Message fields must contain bounded text.");
  return v;
}
export function messageBody(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) => !["question", "context", "files"].includes(k),
    )
  )
    fail(
      "invalid-message",
      "Use question, context and project-relative file names only.",
    );
  const body = {
    question: text(value.question, 3000, true),
    context: text(value.context ?? "", 8000),
  };
  const files = value.files ?? [];
  if (!Array.isArray(files) || files.length > 10)
    fail(
      "invalid-message",
      "At most ten project-relative file names are allowed.",
    );
  body.files = files.map((f) => {
    text(f, 300, true);
    if (
      /^[\\/]|[:\x00-\x1f]/.test(f) ||
      f.split(/[\\/]/).some((s) => ["..", ".", ""].includes(s))
    )
      fail(
        "invalid-message",
        "File names must be clean project-relative references.",
      );
    return f;
  });
  return body;
}
export class TeamService {
  constructor({
    home,
    store = new TeamStore({ home }),
    hub = new Hub({ home }),
    dsh,
  } = {}) {
    this.home = home;
    this.store = store;
    this.dsh = dsh ?? new DshEndpoint({ hub });
  }
  async configure(input) {
    const p = input?.project,
      a = input?.advisor,
      d = input?.dsh;
    if (!p || !a || !d)
      fail(
        "team-config-required",
        "Configure project, advisor and DSH member separately.",
      );
    for (const [value, keys] of [
      [input, ["project", "advisor", "dsh"]],
      [p, ["id", "title", "root", "maxAdvisorCalls", "timeoutMs"]],
      [a, ["id", "command"]],
      [d, ["id", "target", "workspace", "sessionRoots"]],
    ])
      if (
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((k) => !keys.includes(k))
      )
        fail(
          "invalid-team-config",
          "Unknown team configuration fields are rejected; check routing and budget field names.",
        );
    [p.id, a.id, d.id].forEach(name);
    if (
      a.id === d.id ||
      !isAbsolute(p.root ?? "") ||
      !isAbsolute(a.command ?? "")
    )
      fail(
        "invalid-team-config",
        "Use distinct members and controller-local absolute project/CLI paths.",
      );
    const root = await realpath(p.root);
    if (!(await stat(root)).isDirectory() || !(await stat(a.command)).isFile())
      fail(
        "invalid-team-config",
        "Project directory and Codex executable must exist on the controller.",
      );
    const maxAdvisorCalls = p.maxAdvisorCalls ?? 20,
      timeoutMs = p.timeoutMs ?? 120000;
    if (
      !Number.isInteger(maxAdvisorCalls) ||
      maxAdvisorCalls < 1 ||
      maxAdvisorCalls > 100 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 300000
    )
      fail(
        "invalid-team-budget",
        "Set 1–100 advisor calls and 1000–300000 ms per call.",
      );
    const binding = await this.dsh.bind(d);
    await privateDirectory(join(this.home, "team"));
    const config = {
      project: {
        id: p.id,
        title: text(p.title ?? p.id, 200, true),
        root,
        maxAdvisorCalls,
        timeoutMs,
        advisor: a.id,
      },
      advisor: {
        id: a.id,
        kind: "codex",
        projectId: p.id,
        command: a.command,
        cwd: root,
      },
      dsh: { id: d.id, kind: "dsh", projectId: p.id, ...binding },
    };
    const revision = digest(config);
    return this.store.transaction((state) => {
      if (state.projects[p.id]) {
        if (state.projects[p.id].revision !== revision)
          fail(
            "team-config-conflict",
            "Existing project bindings are immutable. Configure a new project identity instead of rerouting old messages.",
          );
        return { projectId: p.id, unchanged: true };
      }
      if (state.members[a.id] || state.members[d.id])
        fail(
          "team-member-conflict",
          "A member identity already belongs to another project.",
        );
      state.projects[p.id] = {
        ...config.project,
        revision,
        enabled: true,
        callsUsed: 0,
      };
      state.members[a.id] = {
        ...config.advisor,
        revision,
        threadId: null,
        threadAdmission: "new",
        busyMessageId: null,
      };
      state.members[d.id] = {
        ...config.dsh,
        revision,
        token: randomUUID() + randomUUID(),
      };
      return { projectId: p.id, advisor: a.id, dsh: d.id };
    });
  }
  async members() {
    const s = await this.store.read();
    return {
      projects: Object.values(s.projects),
      members: Object.values(s.members).map(({ token, ...m }) => m),
    };
  }
  async send({ from, sessionId, requestId, body }) {
    name(from);
    text(requestId, 128, true);
    body = messageBody(body);
    const s = await this.store.read(),
      member = s.members[from];
    if (member?.kind !== "dsh")
      fail("team-member-required", "Use a configured DSH sender member.");
    const project = s.projects[member.projectId];
    if (!project?.enabled)
      fail("team-project-disabled", "This project is not accepting messages.");
    const key = digest({ from, requestId }),
      payloadHash = digest({ sessionId, body });
    const id = "message-" + key.slice(0, 32);
    if (s.messages[id]) {
      if (s.messages[id].payloadHash !== payloadHash)
        fail(
          "message-conflict",
          "This request ID already has different content.",
        );
      return this.receipt({ messageId: id, memberId: from });
    }
    const observed = await this.dsh.observe(member, sessionId);
    await this.store.transaction((state) => {
      const existing = state.messages[id];
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          fail("message-conflict", "Conflicting duplicate message.");
        return;
      }
      if (
        !state.projects[member.projectId]?.enabled ||
        state.members[from]?.revision !== member.revision
      )
        fail(
          "team-config-conflict",
          "The sender binding changed during admission.",
        );
      if (Object.keys(state.messages).length >= 1000)
        fail(
          "mailbox-full",
          "Archive or export old messages before accepting more work.",
        );
      state.messages[id] = {
        id,
        projectId: project.id,
        from,
        to: project.advisor,
        memberRevision: member.revision,
        requestId,
        payloadHash,
        sourceSessionId: sessionId,
        sourceContext: observed.frozen,
        body,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
    });
    return this.receipt({ messageId: id, memberId: from });
  }
  async receipt({ messageId, memberId } = {}) {
    if (!/^message-[a-f0-9]{32}$/.test(messageId ?? ""))
      fail("invalid-message-id", "Choose a recorded message ID.");
    const m = (await this.store.read()).messages[messageId];
    if (!m || (memberId && m.from !== memberId))
      fail("message-not-found", "Message is not in this member's mailbox.");
    return structuredClone(m);
  }
  async list({ projectId } = {}) {
    return Object.values((await this.store.read()).messages).filter(
      (m) => !projectId || m.projectId === projectId,
    );
  }
  async setEnabled({ projectId, enabled }) {
    name(projectId);
    if (typeof enabled !== "boolean")
      fail("invalid-team-config", "enabled must be boolean.");
    return this.store.transaction((s) => {
      if (!s.projects[projectId])
        fail("team-project-not-found", "Project not found.");
      s.projects[projectId].enabled = enabled;
      return { projectId, enabled };
    });
  }
  async setBudget({ projectId, maxCalls }) {
    name(projectId);
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000)
      fail(
        "invalid-team-budget",
        "Choose 1–1000 total advisor admission attempts.",
      );
    return this.store.transaction((s) => {
      const p = s.projects[projectId];
      if (!p) fail("team-project-not-found", "Project not found.");
      (p.budgetChanges ??= []).push({
        at: new Date().toISOString(),
        previous: p.maxAdvisorCalls,
        maxCalls,
      });
      if (p.budgetChanges.length > 100)
        fail(
          "team-budget-history-full",
          "Export this project's history before more budget changes.",
        );
      p.maxAdvisorCalls = maxCalls;
      if (maxCalls > p.callsUsed)
        for (const m of Object.values(s.messages))
          if (m.projectId === projectId && m.status === "budget-exhausted")
            m.status = "queued";
      return {
        projectId,
        maxCalls,
        callsUsed: p.callsUsed,
        routingChanged: false,
      };
    });
  }
}
