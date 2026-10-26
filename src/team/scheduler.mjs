import { randomUUID } from "node:crypto";
import { TeamService } from "./service.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
import { HubError } from "../core/state.mjs";
import { digest } from "../core/placement.mjs";

export class TeamScheduler {
  constructor({
    service,
    advisorFactory = (m) => new CodexAppServer({ command: m.command }),
  } = {}) {
    if (!(service instanceof TeamService))
      throw new HubError(
        "team-service-required",
        "Configure a team service first.",
      );
    this.service = service;
    this.store = service.store;
    this.advisorFactory = advisorFactory;
  }
  async update(id, claim, fn) {
    const mutate = () =>
      this.store.transaction((s) => {
        const m = s.messages[id];
        if (!m || (claim && m.claim !== claim))
          throw new HubError(
            "message-owner-changed",
            "This worker no longer owns the message.",
          );
        return fn(m, s);
      });
    for (let attempt = 0; ; attempt++) {
      try {
        return await mutate();
      } catch (e) {
        if (e.code !== "team-busy" || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
    }
  }
  async tick() {
    const snapshot = await this.store.read();
    const ready = Object.values(snapshot.messages).filter(
      (m) =>
        snapshot.projects[m.projectId]?.enabled &&
        ["answered", "delivery-pending"].includes(m.status),
    );
    let deferred;
    const offset = (this.deliveryCursor ?? 0) % Math.max(ready.length, 1);
    const candidates = [
      ...ready.slice(offset),
      ...ready.slice(0, offset),
    ].slice(0, 5);
    this.deliveryCursor =
      (offset + candidates.length) % Math.max(ready.length, 1);
    for (const message of candidates) {
      const result = await this.deliver(message.id);
      if (result.status === "delivered") return result;
      deferred = result;
    }
    if (
      !Object.values(snapshot.messages).some(
        (m) =>
          m.status === "queued" &&
          snapshot.projects[m.projectId]?.enabled === true &&
          !snapshot.members[m.to]?.busyMessageId,
      )
    )
      return deferred ?? { idle: true };
    const claimed = await this.store.transaction((s) => {
      const m = Object.values(s.messages).find(
        (m) =>
          m.status === "queued" &&
          s.projects[m.projectId]?.enabled &&
          !s.members[m.to]?.busyMessageId,
      );
      if (!m) return null;
      const p = s.projects[m.projectId],
        a = s.members[m.to];
      if (
        !Number.isInteger(p.callsUsed) ||
        p.callsUsed < 0 ||
        !Number.isInteger(p.maxAdvisorCalls) ||
        p.maxAdvisorCalls < 1 ||
        p.maxAdvisorCalls > 1000 ||
        !Number.isInteger(p.timeoutMs) ||
        p.timeoutMs < 1000 ||
        p.timeoutMs > 300000 ||
        a?.kind !== "codex" ||
        a.projectId !== p.id ||
        s.members[m.from]?.projectId !== p.id
      )
        throw new HubError(
          "invalid-team-state",
          "Invalid project budget or member ownership; no model request was started.",
        );
      if (p.callsUsed >= p.maxAdvisorCalls) {
        m.status = "budget-exhausted";
        return { skipped: true, id: m.id };
      }
      if (Date.now() - Date.parse(m.createdAt) > 24 * 60 * 60 * 1000) {
        m.status = "expired";
        return { skipped: true, id: m.id };
      }
      m.status = "processing";
      m.claim = randomUUID();
      m.workerPid = process.pid;
      m.admission = { phase: "claimed" };
      a.busyMessageId = m.id;
      return {
        message: structuredClone(m),
        project: structuredClone(p),
        advisor: structuredClone(a),
        sender: structuredClone(s.members[m.from]),
      };
    });
    if (!claimed && deferred) return deferred;
    if (!claimed || claimed.skipped)
      return {
        idle: !claimed,
        ...(claimed?.id ? { messageId: claimed.id, skipped: true } : {}),
      };
    const { message: m, project, advisor, sender } = claimed;
    let client;
    try {
      client = this.advisorFactory(advisor);
      if (sender.revision !== m.memberRevision)
        throw new HubError(
          "team-config-conflict",
          "Message sender binding changed.",
        );
      await this.service.dsh.observe(
        sender,
        m.sourceSessionId,
        m.sourceContext,
      );
      await client.connect();
      if (!advisor.threadId) {
        if (advisor.threadAdmission !== "new")
          throw new HubError(
            "advisor-thread-uncertain",
            "A previous thread admission needs explicit reconciliation.",
          );
        await this.update(m.id, m.claim, (message, s) => {
          message.admission.phase = "thread-pending";
          s.members[m.to].threadAdmission = "pending";
        });
        advisor.threadId = await client.create(advisor);
        await this.update(m.id, m.claim, (message, s) => {
          s.members[m.to].threadId = advisor.threadId;
          s.members[m.to].threadAdmission = "confirmed";
          message.admission = {
            phase: "thread-ready",
            threadId: advisor.threadId,
          };
        });
      } else {
        await client.resume(advisor);
        await this.update(m.id, m.claim, (message) => {
          message.admission = {
            phase: "thread-ready",
            threadId: advisor.threadId,
          };
        });
      }
      await this.update(m.id, m.claim, (message, s) => {
        if (!s.projects[m.projectId].enabled)
          throw new HubError(
            "team-project-disabled",
            "Project was disabled before model admission.",
          );
        message.admission.phase = "turn-pending";
        s.projects[m.projectId].callsUsed++;
        message.model = client.model ?? null;
        message.effort = client.effort ?? null;
      });
      const turnId = await client.start(advisor, m, project);
      await this.update(m.id, m.claim, (message, s) => {
        s.members[m.to].hasTurn = true;
        message.admission = {
          phase: "running",
          threadId: advisor.threadId,
          turnId,
        };
      });
      const reply = await client.wait(
        advisor.threadId,
        turnId,
        project.timeoutMs,
      );
      await this.complete(m.id, m.claim, reply);
      return { messageId: m.id, status: "answered" };
    } catch (error) {
      await this.update(m.id, m.claim, (message, s) => {
        if (message.reply) return;
        const phase = message.admission.phase;
        message.error = {
          code: error instanceof HubError ? error.code : "advisor-failed",
        };
        if (
          phase === "thread-pending" &&
          error.code === "advisor-rpc-rejected"
        ) {
          // An explicit rejection differs from an acknowledgement loss. No
          // model turn was admitted. Leave an owner-recoverable failed request.
          message.status = "failed";
          message.admission.phase = "claimed";
          s.members[m.to].threadAdmission = "new";
          s.members[m.to].busyMessageId = null;
        } else if (
          phase === "turn-pending" &&
          error.code === "advisor-rpc-rejected"
        ) {
          message.status = "failed";
          message.admission.phase = "rejected";
          s.members[m.to].busyMessageId = null;
          if (!s.members[m.to].hasTurn) {
            s.members[m.to].threadId = null;
            s.members[m.to].threadAdmission = "new";
          }
        } else if (error.code === "advisor-busy" && phase === "claimed") {
          message.status = "queued";
          s.members[m.to].busyMessageId = null;
        } else if (["claimed", "thread-ready"].includes(phase)) {
          message.status = "failed";
          s.members[m.to].busyMessageId = null;
        } else message.status = "uncertain";
      });
      return {
        messageId: m.id,
        status: (await this.service.receipt({ messageId: m.id })).status,
      };
    } finally {
      await client?.close();
    }
  }
  async complete(id, claim, reply) {
    if (
      !reply ||
      typeof reply.text !== "string" ||
      !reply.text.trim() ||
      reply.text.length > 12000 ||
      typeof reply.needsHuman !== "boolean"
    )
      throw new HubError(
        "invalid-advisor-reply",
        "Invalid bounded advisor reply.",
      );
    await this.update(id, claim, (m, s) => {
      if (
        Object.values(s.members).some(
          (member) => member.token && reply.text.includes(member.token),
        ) ||
        /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{16,})/.test(
          reply.text,
        )
      )
        throw new HubError(
          "unsafe-advisor-reply",
          "Possible credential material was detected. No reply was sent.",
        );
      if (m.reply) {
        if (
          digest({ text: m.reply.text, needsHuman: m.reply.needsHuman }) !==
          digest({ text: reply.text, needsHuman: reply.needsHuman })
        )
          throw new HubError(
            "reply-conflict",
            "A different advisor reply is already committed. No second reply may be sent.",
          );
        return;
      }
      if (!["processing", "uncertain"].includes(m.status))
        throw new HubError(
          "message-owner-changed",
          "This message is no longer awaiting advisor completion.",
        );
      m.reply = reply;
      m.status = "answered";
      m.answeredAt = new Date().toISOString();
      delete m.error;
      if (s.members[m.to].busyMessageId === id)
        s.members[m.to].busyMessageId = null;
    });
  }
  async deliver(messageId) {
    let m = await this.service.receipt({ messageId });
    const state = await this.store.read(),
      sender = state.members[m.from];
    if (!state.projects[m.projectId]?.enabled)
      return { messageId, deferred: true };
    try {
      const observed = await this.service.dsh.observe(
        sender,
        m.sourceSessionId,
        m.sourceContext,
      );
      if (m.status === "delivery-pending") {
        const confirmation = await this.service.dsh.confirm(sender, m);
        if (
          !confirmation.accepted ||
          confirmation.requestId !== m.delivery.requestId ||
          confirmation.afterSeq !== m.delivery.afterSeq
        )
          return { messageId, status: "delivery-pending", uncertain: true };
      } else {
        if (m.status !== "answered") return { messageId, status: m.status };
        if (observed.running || observed.inboxPending)
          return { messageId, status: "answered", deferred: true };
        const prepared = await this.update(messageId, null, (message) => {
          if (message.status !== "answered") return null;
          message.delivery = {
            requestId: randomUUID(),
            afterSeq: observed.latestSeq,
            preparedAt: new Date().toISOString(),
          };
          message.status = "delivery-pending";
          return structuredClone(message);
        });
        if (!prepared) return { messageId, superseded: true };
        m = prepared;
        const accepted = await this.service.dsh.deliver(sender, m);
        if (
          !accepted.accepted ||
          accepted.requestId !== m.delivery.requestId ||
          accepted.afterSeq !== m.delivery.afterSeq
        )
          throw new HubError(
            "reply-admission-uncertain",
            "The original reply admission is not confirmed.",
          );
      }
      await this.update(messageId, null, (message) => {
        if (
          message.status === "delivery-pending" &&
          message.delivery.requestId === m.delivery.requestId
        ) {
          message.status = "delivered";
          message.delivery.confirmedAt = new Date().toISOString();
          delete message.deliveryError;
        }
      });
      return {
        messageId,
        status: "delivered",
        meaning: "queued-in-original-session",
      };
    } catch (error) {
      await this.update(messageId, null, (message) => {
        if (
          message.status !== m.status ||
          message.delivery?.requestId !== m.delivery?.requestId
        )
          return;
        message.deliveryError = {
          code: error instanceof HubError ? error.code : "reply-failed",
        };
      });
      const latest = await this.service.receipt({ messageId });
      return {
        messageId,
        status: latest.status,
        deferred: latest.status !== "delivered",
      };
    }
  }
  async recover({ messageId }) {
    const m = await this.service.receipt({ messageId });
    if (
      m.status === "processing" &&
      ["claimed", "thread-ready"].includes(m.admission?.phase)
    ) {
      if (!Number.isInteger(m.workerPid) || m.workerPid < 1)
        throw new HubError(
          "worker-state-unknown",
          "Cannot prove the original pre-admission worker has exited.",
        );
      let alive = true;
      try {
        process.kill(m.workerPid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
      if (alive) return { messageId, running: true, promptSent: false };
      await this.update(m.id, m.claim, (message, s) => {
        if (
          message.status !== "processing" ||
          !["claimed", "thread-ready"].includes(message.admission.phase)
        )
          throw new HubError(
            "message-owner-changed",
            "The original admission progressed during recovery.",
          );
        message.status = "queued";
        if (s.members[m.to].busyMessageId === m.id)
          s.members[m.to].busyMessageId = null;
        if (
          !s.members[m.to].hasTurn &&
          message.admission.phase === "thread-ready"
        ) {
          s.members[m.to].threadId = null;
          s.members[m.to].threadAdmission = "new";
        }
      });
      return { messageId, status: "queued", promptSent: false };
    }
    if (["answered", "delivery-pending"].includes(m.status))
      return this.deliver(messageId);
    if (!["processing", "uncertain", "failed"].includes(m.status))
      return { messageId, status: m.status };
    if (
      ["claimed", "thread-ready", "rejected"].includes(m.admission?.phase) &&
      m.status === "failed"
    ) {
      await this.update(messageId, m.claim, (message) => {
        message.status = "queued";
      });
      return { messageId, status: "queued", promptSent: false };
    }
    if (!m.admission?.threadId)
      throw new HubError(
        "advisor-thread-uncertain",
        "Thread creation acknowledgement was lost. Inspect the owned advisor admission; recovery never creates another thread.",
      );
    const state = await this.store.read(),
      member = state.members[m.to],
      client = this.advisorFactory(member);
    try {
      await client.connect();
      const recovered = await client.recover(m);
      if (recovered.completed) {
        await this.complete(m.id, m.claim, recovered.reply);
        return { messageId, status: "answered", promptSent: false };
      }
      if (recovered.failed)
        await this.update(m.id, m.claim, (message, s) => {
          message.status = "failed";
          if (s.members[m.to].busyMessageId === m.id)
            s.members[m.to].busyMessageId = null;
        });
      return { messageId, ...recovered, promptSent: false };
    } finally {
      await client.close();
    }
  }
}
