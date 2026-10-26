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
  async receipt({ jobId } = {}) {
    if (typeof jobId !== "string" || !/^job-[a-f0-9-]{36}$/.test(jobId))
      throw new HubError("invalid-job", "Invalid job ID.");
    return readJson(join(this.home, "jobs", jobId + ".json"));
  }
  checkPromptPolicy(job, target, text) {
    if (job.version !== 2)
      throw new HubError(
        "legacy-follow-up-disabled",
        "Create a fully configured v2 job for follow-up work; this legacy session is unchanged.",
      );
    if (digest(target.workspaces[job.workspace]) !== job.mappingHash)
      throw new HubError(
        "mapping-changed",
        "This mapping changed after dispatch. Read, wait or cancel the original job, or dispatch a new one.",
      );
    if (typeof text !== "string" || !text.trim())
      throw new HubError("task-required", "A nonempty task is required.");
  }
  // Caller owns the short job writer lock. Persist the identity before the RPC,
  // A lost response cannot mint a second request. Reconfirmation is read-only.
  async sendRecorded(adapter, job, text) {
    if (job.pendingPrompt)
      throw new HubError(
        "prompt-admission-uncertain",
        "The previous prompt may already be queued. Wait, or use retry with the identical text and recorded request ID.",
      );
    if (
      job.safetyVersion === 1 &&
      job.requestId &&
      job.runAudit?.state !== "finished"
    )
      throw new HubError(
        "source-run-active",
        "Finish and inspect the current run with wait or changes before sending another task.",
      );
    const pending = {
      requestId: randomUUID(),
      ...(await adapter.cursor({ sessionId: job.sessionId })),
      textHash: digest(text),
      ...(job.safetyVersion === 1 ? { stage: "run" } : {}),
    };
    if (!pending || pending.textHash !== digest(text))
      throw new HubError(
        "retry-text-mismatch",
        "Retry requires the exact original task text; no prompt was sent.",
      );
    if (!Number.isSafeInteger(pending.afterSeq) || pending.afterSeq < -1)
      throw new HubError(
        "invalid-prompt-admission",
        "The backend did not return a valid history cursor.",
      );
    job.previousResult = job.backendResult ?? job.result;
    delete job.result;
    delete job.backendResult;
    delete job.placementError;
    Object.assign(job, {
      pendingPrompt: pending,
      requestId: pending.requestId,
      afterSeq: pending.afterSeq,
      state: "prompt-admission-pending",
    });
    const file = join(this.home, "jobs", job.id + ".json");
    await atomicJson(file, job);
    if (job.safetyVersion === 1) {
      try {
        job.runAudit = await adapter.beginRun({
          jobId: job.id,
          sessionId: job.sessionId,
          requestId: pending.requestId,
        });
        if (
          job.runAudit.state !== "running" ||
          job.runAudit.requestId !== pending.requestId
        )
          throw new HubError(
            "invalid-run-admission",
            "Target did not confirm this run's source lease and baseline.",
          );
        pending.stage = "prompt";
        await atomicJson(file, job);
      } catch (error) {
        job.state = "run-admission-unconfirmed";
        job.runError = { code: error.code ?? "run-admission-unconfirmed" };
        await atomicJson(file, job);
        throw new HubError(
          error instanceof HubError ? error.code : "run-admission-unconfirmed",
          "Source lease or baseline admission was not confirmed. No prompt was sent. Inspect this job before creating another task.",
          { jobId: job.id, target: job.target, sessionId: job.sessionId },
        );
      }
    }
    try {
      const sent = await adapter.send({
        sessionId: job.sessionId,
        text: placementInstructions(job.context, text),
        requestId: pending.requestId,
        afterSeq: pending.afterSeq,
      });
      if (
        sent.requestId !== pending.requestId ||
        sent.afterSeq !== pending.afterSeq
      )
        throw new HubError(
          "prompt-identity-mismatch",
          "The backend did not preserve the recorded prompt identity.",
        );
      const accepted = { ...job, state: "accepted" };
      delete accepted.pendingPrompt;
      delete accepted.promptError;
      await atomicJson(file, accepted);
      Object.assign(job, accepted);
      delete job.pendingPrompt;
      delete job.promptError;
      return sent;
    } catch (error) {
      job.state = "prompt-admission-uncertain";
      job.promptError = {
        code:
          typeof error.code === "string" &&
          /^[a-z][a-z0-9-]{1,70}$/.test(error.code)
            ? error.code
            : "backend-error",
      };
      await atomicJson(file, job);
      throw new HubError(
        "prompt-admission-uncertain",
        "The prompt response was not confirmed. Its request ID is retained; wait or retry the identical text on this job, rather than dispatching a new job.",
        { jobId: job.id, target: job.target, sessionId: job.sessionId },
      );
    }
  }
  async afterWait(adapter, job, result) {
    // Completion evidence remains readable even when placement later drifts.
    await withJobWriter(this.home, job.id, async () => {
      const latest = await this.receipt({ jobId: job.id });
      if (latest.requestId !== job.requestId) return;
      latest.backendResult = result;
      if (result.completed) delete latest.pendingPrompt;
      await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
    });
    job.backendResult = result;
    if (result.completed) delete job.pendingPrompt;
    if (job.safetyVersion === 1) {
      try {
        const audit = await adapter.finishRun({
          jobId: job.id,
          sessionId: job.sessionId,
          requestId: job.requestId,
        });
        job.runAudit = audit;
        await withJobWriter(this.home, job.id, async () => {
          const latest = await this.receipt({ jobId: job.id });
          if (latest.requestId !== job.requestId) return;
          latest.runAudit = audit;
          delete latest.runError;
          await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
        });
      } catch (error) {
        job.runError = { code: "run-audit-unconfirmed" };
        await withJobWriter(this.home, job.id, async () => {
          const latest = await this.receipt({ jobId: job.id });
          if (latest.requestId !== job.requestId) return;
          latest.runError = job.runError;
          await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
        });
        throw new HubError(
          "run-audit-unconfirmed",
          "Backend result retained; source lease remains held until target audit succeeds. Use changes to reconcile this run.",
          { jobId: job.id, target: job.target, sessionId: job.sessionId },
        );
      }
    }
    try {
      const verified = await adapter.verify({
        jobId: job.id,
        sessionId: job.sessionId,
      });
      assertContext(verified.context, job.context);
    } catch (error) {
      const placementError = {
        code:
          typeof error.code === "string" &&
          /^[a-z][a-z0-9-]{1,70}$/.test(error.code)
            ? error.code
            : "placement-verification-failed",
        message:
          "Backend result retained, but the job placement failed verification. Read the receipt before continuing.",
      };
      job.placementError = placementError;
      await withJobWriter(this.home, job.id, async () => {
        const latest = await this.receipt({ jobId: job.id });
        if (latest.requestId !== job.requestId) return;
        latest.placementError = placementError;
        await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
      });
      throw new HubError(placementError.code, placementError.message, {
        jobId: job.id,
        target: job.target,
        sessionId: job.sessionId,
      });
    }
  }
  async recover({ jobId } = {}) {
    await this.receipt({ jobId });
    return withJobWriter(this.home, jobId, async () => {
      const { job, selected } = await this.resolveJob(jobId, {
        allowMissingSession: true,
      });
      if (
        job.version !== 2 ||
        job.requestId ||
        job.pendingPrompt ||
        job.state === "cancellation-requested"
      )
        throw new HubError(
          "recovery-not-available",
          "Only an unprompted v2 placement admission can be recovered; existing running tasks are unchanged.",
        );
      if (digest(selected.workspaces[job.workspace]) !== job.mappingHash)
        throw new HubError(
          "mapping-changed",
          "Restore the original mapping before recovering its frozen placement plan.",
        );
      const prepared = await this.withAdapter(selected, async (a) => {
        await a.assertInstance(job.instance);
        return a.prepare({
          jobId: job.id,
          plan: job.plan,
          ...(job.safetyVersion === 1
            ? { safetyVersion: 1, capability: job.capability }
            : {}),
        });
      });
      if (
        job.safetyVersion === 1 &&
        digest(prepared.context?.safety) !==
          digest({ version: 1, capability: job.capability })
      )
        throw new HubError(
          "capability-mismatch",
          "Recovered placement did not preserve the original task capability.",
        );
      Object.assign(job, {
        sessionId: prepared.sessionId,
        context: prepared.context,
        cwd: prepared.context.execution.actualCwd,
        state: "prepared",
      });
      delete job.error;
      await atomicJson(join(this.home, "jobs", job.id + ".json"), job);
      return {
        jobId: job.id,
        target: job.target,
        ...prepared,
        promptSent: false,
      };
    });
  }
  async retryPrompt({ jobId, text } = {}) {
    await this.receipt({ jobId });
    return withJobWriter(this.home, jobId, async () => {
      const { job, selected } = await this.resolveJob(jobId);
      this.checkPromptPolicy(job, selected, text);
      if (!job.pendingPrompt)
        throw new HubError(
          "retry-not-available",
          "This job has no unconfirmed prompt to retry.",
        );
      if (job.safetyVersion === 1 && job.pendingPrompt.stage !== "prompt")
        throw new HubError(
          "run-admission-unconfirmed",
          "This job did not reach prompt admission. Retry never resends a prompt or bypasses its source lease.",
        );
      if (job.pendingPrompt.textHash !== digest(text))
        throw new HubError(
          "retry-text-mismatch",
          "Retry requires the exact original task text; no prompt was sent.",
        );
      return this.withAdapter(selected, async (a) => {
        await a.assertInstance(job.instance);
        const verified = await a.verify({
          jobId: job.id,
          sessionId: job.sessionId,
        });
        assertContext(verified.context, job.context);
        const pending = job.pendingPrompt;
        const confirmed = await a.confirmPrompt({
          sessionId: job.sessionId,
          requestId: pending.requestId,
          afterSeq: pending.afterSeq,
        });
        if (!confirmed.accepted)
          throw new HubError(
            "prompt-admission-uncertain",
            "The original request is not yet visible. No prompt was resent; keep waiting or explicitly cancel and investigate this job.",
            { jobId: job.id, target: job.target, sessionId: job.sessionId },
          );
        if (
          confirmed.requestId !== pending.requestId ||
          confirmed.afterSeq !== pending.afterSeq
        )
          throw new HubError(
            "prompt-identity-mismatch",
            "The backend confirmation did not preserve the recorded prompt identity; it remains uncertain.",
          );
        const accepted = { ...job, state: "accepted" };
        delete accepted.pendingPrompt;
        delete accepted.promptError;
        await atomicJson(join(this.home, "jobs", job.id + ".json"), accepted);
        return { jobId: job.id, target: job.target, ...confirmed };
      });
    });
  }
  async dispatch({
    target,
    workspace,
    text,
    timeoutMs = 55000,
    capability = "coding",
  } = {}) {
    if (!["coding", "readonly"].includes(capability))
      throw new HubError(
        "invalid-capability",
        "Choose coding or readonly capability.",
      );
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
        const inspection = await a.assertInstance(receipt.instance);
        if (inspection?.capabilities?.safeRunsVersion === 1) {
          receipt.safetyVersion = 1;
          receipt.capability = capability;
          receipt.safety = { supported: true };
        } else {
          receipt.safety = { supported: false };
          if (capability === "readonly")
            throw new HubError(
              "readonly-unsupported",
              "This target companion does not enforce readonly runs. Update it before readonly dispatch.",
            );
        }
        await atomicJson(path, receipt);
        const prepared = await a.prepare({
          jobId: receipt.id,
          plan,
          ...(receipt.safetyVersion === 1
            ? { safetyVersion: 1, capability }
            : {}),
        });
        if (
          receipt.safetyVersion === 1 &&
          digest(prepared.context?.safety) !==
            digest({ version: 1, capability })
        )
          throw new HubError(
            "capability-mismatch",
            "Target did not preserve the frozen task capability.",
          );
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
          await this.sendRecorded(a, receipt, text);
        });
        const result = await a.wait({
          sessionId: receipt.sessionId,
          requestId: receipt.requestId,
          afterSeq: receipt.afterSeq,
          timeoutMs,
        });
        await this.afterWait(a, receipt, result);
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
        safety: receipt.safety,
        ...(receipt.safetyVersion === 1
          ? { capability: receipt.capability, runAudit: receipt.runAudit }
          : {}),
        ...result,
        ...(superseded ? { superseded: true } : {}),
      };
    } catch (error) {
      if (!receipt.sessionId && typeof error.details?.sessionId === "string")
        receipt.sessionId = error.details.sessionId;
      receipt.state =
        receipt.runError && receipt.pendingPrompt?.stage === "run"
          ? "run-admission-unconfirmed"
          : receipt.pendingPrompt
            ? "prompt-admission-uncertain"
            : "error";
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
  async resolveJob(id, { allowMissingSession = false } = {}) {
    if (typeof id !== "string" || !/^job-[a-f0-9-]{36}$/.test(id))
      throw new HubError("invalid-job", "Invalid job ID.");
    const job = await readJson(join(this.home, "jobs", id + ".json"));
    const selected = await this.target(job.target);
    if (job.targetFingerprint !== fingerprint(selected))
      throw new HubError(
        "target-changed",
        "This job belongs to the target connection captured at dispatch. Restore that connection or create a new job.",
      );
    if (!job.sessionId && !allowMissingSession)
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
  async changes({ jobId, requestId } = {}) {
    const { job, selected } = await this.resolveJob(jobId);
    if (job.safetyVersion !== 1)
      throw new HubError(
        "safe-runs-unsupported",
        "This existing job has no safety run record; it is not retroactively enrolled.",
      );
    requestId ??= job.requestId;
    if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId))
      throw new HubError(
        "request-required",
        "Choose this job's recorded request ID.",
      );
    const audit = await this.withAdapter(selected, async (a) => {
      await a.assertInstance(job.instance);
      return a.changes({ jobId: job.id, sessionId: job.sessionId, requestId });
    });
    await withJobWriter(this.home, job.id, async () => {
      const latest = await this.receipt({ jobId: job.id });
      if (latest.requestId !== requestId) return;
      latest.runAudit = audit;
      delete latest.runError;
      await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
    });
    return { jobId: job.id, target: job.target, ...audit };
  }
  async operate(operation, { jobId, text, timeoutMs = 55000 } = {}) {
    if (!["send", "wait", "messages", "cancel"].includes(operation))
      throw new HubError("invalid-operation", "Unsupported job operation.");
    const { job, selected } = await this.resolveJob(jobId);
    const invoke = (current, target) =>
      this.withAdapter(target, async (a) => {
        await a.assertInstance(current.instance);
        if (operation === "send") {
          this.checkPromptPolicy(current, target, text);
          if (current.pendingPrompt)
            throw new HubError(
              "prompt-admission-uncertain",
              "The previous prompt may already be queued. Wait or retry the same text on this job.",
            );
          if (!current.requestId && current.state !== "prepared")
            throw new HubError(
              "request-unavailable",
              "The first task has not been admitted. Wait for dispatch admission before sending a follow-up.",
            );
        }
        if (current.version === 2 && !["cancel", "wait"].includes(operation)) {
          const verified = await a.verify({
            jobId: current.id,
            sessionId: current.sessionId,
          });
          assertContext(verified.context, current.context);
        }
        if (operation === "send") return this.sendRecorded(a, current, text);
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
          await this.afterWait(a, current, result);
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
          latest.afterSeq !== job.afterSeq ||
          latest.state === "cancellation-requested";
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
