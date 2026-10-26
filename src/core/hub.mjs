import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDshAdapter } from "../adapters/dsh.mjs";
import { withJobWriter } from "./job-lock.mjs";
import {
  planPlacement,
  digest,
  placementInstructions,
  assertContext,
} from "./placement.mjs";
import { PlacementError } from "../../packages/dsh-companion/lib/placement.mjs";
import {
  loadConfig,
  readJson,
  atomicJson,
  fingerprint,
  validName,
  HubError,
  placementChecked,
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
        mappingStatus: Object.fromEntries(
          Object.entries(t.workspaces).map(([alias, mapping]) => [
            alias,
            typeof mapping === "string"
              ? "legacy-migration-required"
              : "placement-v2",
          ]),
        ),
        instance: t.instance ?? null,
        migrationRequired: Object.values(t.workspaces).some(
          (v) => typeof v === "string",
        ),
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
      if (error instanceof PlacementError)
        throw new HubError(error.code, error.message, {
          target: target.name,
          field: error.field,
        });
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
  async inspect({ target } = {}) {
    const selected = await this.target(target);
    return {
      target: selected.name,
      ...(await this.withAdapter(selected, (a) => a.inspect())),
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
    const mapping = selected.workspaces[workspace];
    if (typeof mapping === "string" || !selected.instance)
      throw new HubError(
        "migration-required",
        "This mapping has no instance, DSH workspace, execution directory and source scope binding. Inspect the selected target and explicitly configure placement v2 before a new dispatch.",
      );
    const id = "job-" + randomUUID();
    const createdAt = new Date().toISOString();
    const plan = placementChecked(() =>
      planPlacement({
        instance: selected.instance,
        mapping,
        targetName: selected.name,
        mappingName: workspace,
        jobId: id,
        now: createdAt,
      }),
    );
    const receipt = {
      version: 2,
      id,
      target: selected.name,
      adapter: selected.adapter,
      targetFingerprint: fingerprint(selected),
      workspace,
      instance: structuredClone(selected.instance),
      mapping: structuredClone(mapping),
      mappingHash: digest(mapping),
      plan,
      cwd: plan.execution.requestedCwd,
      createdAt,
      state: "dispatching",
    };
    const path = join(this.home, "jobs", receipt.id + ".json");
    await atomicJson(path, receipt);
    try {
      const result = await this.withAdapter(selected, async (a) => {
        await a.assertInstance(receipt.instance);
        const prepared = await a.prepare({ jobId: receipt.id, plan });
        Object.assign(receipt, {
          sessionId: prepared.sessionId,
          context: prepared.context,
          cwd: prepared.context.execution.actualCwd,
        });
        await atomicJson(path, receipt);
        const verified = await a.verify({
          jobId: receipt.id,
          sessionId: receipt.sessionId,
        });
        assertContext(verified.context, receipt.context);
        await withJobWriter(this.home, receipt.id, async () => {
          const latest = await readJson(path);
          if (latest.state === "cancellation-requested")
            throw new HubError(
              "dispatch-cancelled",
              "This session was cancelled before its first task prompt. No task was sent.",
            );
          const sent = await a.send({
            sessionId: receipt.sessionId,
            text: placementInstructions(receipt.context, text),
          });
          Object.assign(receipt, sent, { state: "accepted" });
          await atomicJson(path, receipt);
        });
        const result = await a.wait({
          sessionId: receipt.sessionId,
          requestId: receipt.requestId,
          afterSeq: receipt.afterSeq,
          timeoutMs,
        });
        const after = await a.verify({
          jobId: receipt.id,
          sessionId: receipt.sessionId,
        });
        assertContext(after.context, receipt.context);
        return {
          sessionId: receipt.sessionId,
          requestId: receipt.requestId,
          afterSeq: receipt.afterSeq,
          ...result,
        };
      });
      Object.assign(receipt, {
        sessionId: result.sessionId,
        requestId: result.requestId,
        afterSeq: result.afterSeq ?? -1,
        state: result.status,
        result,
      });
      const superseded = await withJobWriter(
        this.home,
        receipt.id,
        async () => {
          const latest = await readJson(path);
          if (
            latest.requestId !== receipt.requestId ||
            latest.state === "cancellation-requested"
          )
            return true;
          await atomicJson(path, receipt);
          return false;
        },
      );
      return {
        jobId: receipt.id,
        target: selected.name,
        workspace,
        context: receipt.context,
        ...result,
        ...(superseded ? { superseded: true } : {}),
      };
    } catch (error) {
      if (!receipt.sessionId && typeof error.details?.sessionId === "string")
        receipt.sessionId = error.details.sessionId;
      receipt.state = "error";
      receipt.error = {
        code: error.code ?? "backend-error",
        message:
          error instanceof HubError
            ? error.message
            : "Backend operation failed.",
      };
      await withJobWriter(this.home, receipt.id, async () => {
        const latest = await readJson(path);
        if (
          (latest.requestId && latest.requestId !== receipt.requestId) ||
          latest.state === "cancellation-requested"
        )
          return;
        await atomicJson(path, receipt);
      });
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
    if (job.version === 2) {
      if (digest(job.instance) !== digest(selected.instance))
        throw new HubError(
          "instance-changed",
          "This job is bound to a different DSH instance. Restore the original target binding.",
        );
    } else {
      const binding = await readJson(
        join(this.home, "legacy-bindings", id + ".json"),
        null,
      );
      if (
        !binding ||
        binding.targetFingerprint !== job.targetFingerprint ||
        binding.sessionId !== job.sessionId ||
        digest(binding.instance) !== digest(selected.instance)
      )
        throw new HubError(
          "legacy-job-unbound",
          "This v1 job has no verified instance binding. Use legacy-bind explicitly; it does not move or stop the session.",
        );
      job.instance = binding.instance;
      job.legacyBinding = binding;
    }
    return { job, selected };
  }
  async bindLegacy({ jobId, target } = {}) {
    if (!/^job-[a-f0-9-]{36}$/.test(jobId ?? ""))
      throw new HubError("invalid-job", "Invalid job ID.");
    const job = await readJson(join(this.home, "jobs", jobId + ".json"));
    if (job.version !== 1 || !job.sessionId)
      throw new HubError(
        "invalid-legacy-job",
        "Only an existing v1 session can be explicitly bound.",
      );
    const selected = await this.target(target ?? job.target);
    if (
      selected.name !== job.target ||
      fingerprint(selected) !== job.targetFingerprint
    )
      throw new HubError(
        "target-changed",
        "Restore this legacy job's original connection before binding it.",
      );
    if (!selected.instance)
      throw new HubError(
        "migration-required",
        "Configure a verified instance binding first.",
      );
    const context = await this.withAdapter(selected, async (a) => {
      await a.assertInstance(selected.instance);
      return a.observeLegacy({ sessionId: job.sessionId });
    });
    // This is a separate, explicit controller-side association. Never mutate the DSH session.
    const binding = {
      version: 1,
      jobId,
      sessionId: job.sessionId,
      targetFingerprint: job.targetFingerprint,
      instance: selected.instance,
      observed: context,
      boundAt: new Date().toISOString(),
    };
    await atomicJson(
      join(this.home, "legacy-bindings", jobId + ".json"),
      binding,
    );
    return binding;
  }
  async verify({ jobId } = {}) {
    const { job, selected } = await this.resolveJob(jobId);
    if (job.version !== 2)
      throw new HubError(
        "legacy-placement-unsupported",
        "Legacy jobs have no enforced placement contract; inspect their explicit binding.",
      );
    return this.withAdapter(selected, async (a) => {
      await a.assertInstance(job.instance);
      const verified = await a.verify({
        jobId: job.id,
        sessionId: job.sessionId,
      });
      assertContext(verified.context, job.context);
      return { jobId: job.id, target: job.target, ...verified };
    });
  }
  async readArtifact({ jobId, path } = {}) {
    const { job, selected } = await this.resolveJob(jobId);
    if (job.version !== 2)
      throw new HubError(
        "legacy-placement-unsupported",
        "Legacy jobs have no recorded task cwd and source scope for artifact reads.",
      );
    return this.withAdapter(selected, async (a) => {
      await a.assertInstance(job.instance);
      const verified = await a.verify({
        jobId: job.id,
        sessionId: job.sessionId,
      });
      assertContext(verified.context, job.context);
      return {
        jobId: job.id,
        target: job.target,
        ...(await a.readArtifact({
          jobId: job.id,
          sessionId: job.sessionId,
          path,
        })),
      };
    });
  }
  async operate(operation, { jobId, text, timeoutMs = 55000 } = {}) {
    if (!["send", "wait", "messages", "cancel"].includes(operation))
      throw new HubError("invalid-operation", "Unsupported job operation.");
    const { job, selected } = await this.resolveJob(jobId);
    const invoke = (current, target) =>
      this.withAdapter(target, async (a) => {
        await a.assertInstance(current.instance);
        if (operation === "send") {
          if (current.version !== 2)
            throw new HubError(
              "legacy-follow-up-disabled",
              "Create a fully configured v2 job for follow-up work; this legacy session is unchanged.",
            );
          if (
            digest(target.workspaces[current.workspace]) !== current.mappingHash
          )
            throw new HubError(
              "mapping-changed",
              "This mapping changed after dispatch. Read, wait or cancel the original job, or dispatch a new one.",
            );
          if (typeof text !== "string" || !text.trim())
            throw new HubError("task-required", "A nonempty task is required.");
          if (!current.requestId)
            throw new HubError(
              "request-unavailable",
              "The first task has not been admitted. Wait for dispatch admission before sending a follow-up.",
            );
        }
        if (current.version === 2 && operation !== "cancel") {
          const verified = await a.verify({
            jobId: current.id,
            sessionId: current.sessionId,
          });
          assertContext(verified.context, current.context);
        }
        const result = await a[operation]({
          sessionId: current.sessionId,
          afterSeq: current.afterSeq,
          requestId: current.requestId,
          ...(text === undefined
            ? {}
            : { text: placementInstructions(current.context, text) }),
          ...(operation === "wait" ? { timeoutMs } : {}),
        });
        if (current.version === 2 && operation === "wait") {
          const verified = await a.verify({
            jobId: current.id,
            sessionId: current.sessionId,
          });
          assertContext(verified.context, current.context);
        }
        return result;
      });
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
