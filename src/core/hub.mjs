import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDshAdapter } from "../adapters/dsh.mjs";
import { withJobWriter } from "./job-lock.mjs";
import {
  loadConfig,
  readJson,
  atomicJson,
  fingerprint,
  validName,
  HubError,
} from "./state.mjs";

export class AdapterRegistry {
  constructor() {
    this.factories = new Map();
  }
  register(name, factory) {
    validName(name, "adapter");
    if (this.factories.has(name) || typeof factory !== "function")
      throw new HubError(
        "adapter-conflict",
        "Adapter registration is invalid or duplicated.",
      );
    this.factories.set(name, factory);
    return this;
  }
  async create(target, context) {
    const factory = this.factories.get(target.adapter);
    if (!factory)
      throw new HubError(
        "adapter-not-found",
        "Target adapter is not installed.",
        { adapter: target.adapter },
      );
    return factory(target, context);
  }
}
export function defaultRegistry() {
  return new AdapterRegistry().register("dsh", createDshAdapter);
}
export class Hub {
  constructor({ home, registry = defaultRegistry() } = {}) {
    this.home = home;
    this.registry = registry;
  }
  async target(name) {
    const config = await loadConfig(this.home);
    name ??= config.defaultTarget;
    if (!name || !Object.hasOwn(config.targets, name))
      throw new HubError(
        "target-required",
        "Choose a configured target with --target or target use.",
      );
    return { ...config.targets[name], name };
  }
  async targets() {
    const config = await loadConfig(this.home);
    return {
      defaultTarget: config.defaultTarget ?? null,
      targets: Object.entries(config.targets).map(([name, t]) => ({
        name,
        adapter: t.adapter,
        connectionKind: t.connection.kind,
        workspaces: Object.keys(t.workspaces),
      })),
    };
  }
  async withAdapter(target, fn) {
    let adapter;
    try {
      adapter = await this.registry.create(target, { home: this.home });
      return await fn(adapter);
    } catch (error) {
      if (error instanceof HubError) throw error;
      if ([401, 403].includes(error.details?.status))
        throw new HubError(
          "authentication-required",
          "The selected DSH rejected authentication. Pair a remote target again, or check the chosen local companion.",
          { target: target.name },
        );
      throw new HubError(
        "backend-error",
        "The selected backend failed. Check authentication, endpoint readiness and the target configuration.",
        {
          target: target.name,
          backendCode: typeof error.code === "string" ? error.code : undefined,
        },
      );
    } finally {
      await adapter?.close?.();
    }
  }
  async status({ target } = {}) {
    const selected = await this.target(target);
    return {
      target: selected.name,
      adapter: selected.adapter,
      status: await this.withAdapter(selected, (a) => a.status()),
    };
  }
  async dispatch({ target, workspace, text, timeoutMs = 55000 } = {}) {
    const selected = await this.target(target);
    if (!workspace || !Object.hasOwn(selected.workspaces, workspace))
      throw new HubError(
        "workspace-required",
        "Choose an explicitly mapped workspace on this target.",
      );
    if (typeof text !== "string" || !text.trim())
      throw new HubError("task-required", "A nonempty task is required.");
    const receipt = {
      version: 1,
      id: "job-" + randomUUID(),
      target: selected.name,
      adapter: selected.adapter,
      targetFingerprint: fingerprint(selected),
      workspace,
      cwd: selected.workspaces[workspace],
      createdAt: new Date().toISOString(),
      state: "dispatching",
    };
    const path = join(this.home, "jobs", receipt.id + ".json");
    await atomicJson(path, receipt);
    try {
      const result = await this.withAdapter(selected, async (a) => {
        // Admission is durable before waiting, so timeout/connection loss cannot orphan a known session.
        return a.dispatch({
          cwd: receipt.cwd,
          text,
          timeoutMs,
          onAdmitted: async (admission) => {
            Object.assign(receipt, admission);
            await atomicJson(path, receipt);
          },
        });
      });
      Object.assign(receipt, {
        sessionId: result.sessionId,
        requestId: result.requestId,
        afterSeq: result.afterSeq ?? -1,
        state: result.status,
        result,
      });
      await atomicJson(path, receipt);
      return { jobId: receipt.id, target: selected.name, workspace, ...result };
    } catch (error) {
      receipt.state = "error";
      receipt.error = {
        code: error.code ?? "backend-error",
        message:
          error instanceof HubError
            ? error.message
            : "Backend operation failed.",
      };
      await atomicJson(path, receipt);
      throw new HubError(receipt.error.code, receipt.error.message, {
        jobId: receipt.id,
        target: receipt.target,
        sessionId: receipt.sessionId ?? null,
      });
    }
  }
  async resolveJob(id) {
    if (typeof id !== "string" || !/^job-[a-f0-9-]{36}$/.test(id))
      throw new HubError("invalid-job", "Invalid job ID.");
    const job = await readJson(join(this.home, "jobs", id + ".json"));
    const selected = await this.target(job.target);
    if (job.targetFingerprint !== fingerprint(selected))
      throw new HubError(
        "target-changed",
        "This job belongs to the target connection captured at dispatch. Restore that connection or create a new job.",
      );
    if (!job.sessionId)
      throw new HubError(
        "session-unavailable",
        "This job has no confirmed backend session. Inspect its admission error.",
      );
    return { job, selected };
  }
  async operate(operation, { jobId, text, timeoutMs = 55000 } = {}) {
    if (!["send", "wait", "messages", "cancel"].includes(operation))
      throw new HubError("invalid-operation", "Unsupported job operation.");
    const { job, selected } = await this.resolveJob(jobId);
    const invoke = (current, target) =>
      this.withAdapter(target, (a) =>
        a[operation]({
          sessionId: current.sessionId,
          afterSeq: current.afterSeq,
          requestId: current.requestId,
          ...(text === undefined ? {} : { text }),
          ...(operation === "wait" ? { timeoutMs } : {}),
        }),
      );
    if (operation === "messages")
      return {
        jobId: job.id,
        target: job.target,
        ...(await invoke(job, selected)),
      };
    if (operation === "wait") {
      const result = await invoke(job, selected);
      return withJobWriter(this.home, job.id, async () => {
        const { job: latest } = await this.resolveJob(job.id);
        const superseded =
          latest.requestId !== job.requestId ||
          latest.afterSeq !== job.afterSeq;
        if (!superseded && !(latest.result?.completed && result.timedOut)) {
          latest.state = result.status;
          latest.result = result;
          await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
        }
        return {
          jobId: job.id,
          target: job.target,
          ...result,
          ...(superseded ? { superseded: true } : {}),
        };
      });
    }
    return withJobWriter(this.home, job.id, async () => {
      const { job: latest, selected: target } = await this.resolveJob(job.id);
      const result = await invoke(latest, target);
      if (operation === "send") {
        latest.requestId = result.requestId;
        latest.afterSeq = result.afterSeq;
        latest.state = "accepted";
      } else latest.state = "cancellation-requested";
      await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
      return { jobId: job.id, target: job.target, ...result };
    });
  }
}
