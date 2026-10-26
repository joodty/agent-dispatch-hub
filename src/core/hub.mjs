import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDshAdapter } from "../adapters/dsh.mjs";
import { withJobWriter } from "./job-lock.mjs";
import { decisionInstructions } from "./questions.mjs";
import {
  pendingQuestion,
  confirmAnswer,
  reconcileDecision,
} from "./decisions.mjs";
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
    if (job.safetyVersion)
      throw new HubError(
        "safe-runs-unsupported",
        "This job was created by the safety preview. Continue with that version; this release cannot send new prompts or bypass its source leases.",
      );
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
  async sendRecorded(adapter, job, text, { answerQuestion } = {}) {
    if (job.pendingPrompt)
      throw new HubError(
        "prompt-admission-uncertain",
        "The previous prompt may already be queued. Wait, or use retry with the identical text and recorded request ID.",
      );
    const pending = {
      requestId: randomUUID(),
      ...(await adapter.cursor({ sessionId: job.sessionId })),
      textHash: digest(text),
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
    if (answerQuestion) {
      pending.questionId = answerQuestion.id;
      answerQuestion.state = "answer-pending";
      answerQuestion.answer = {
        text,
        textHash: digest(text),
        requestId: pending.requestId,
        afterSeq: pending.afterSeq,
        submittedAt: new Date().toISOString(),
      };
    }
    job.previousResult = job.backendResult ?? job.result;
    delete job.result;
    delete job.backendResult;
    delete job.placementError;
    delete job.questionError;
    Object.assign(job, {
      pendingPrompt: pending,
      requestId: pending.requestId,
      afterSeq: pending.afterSeq,
      state: "prompt-admission-pending",
    });
    const file = join(this.home, "jobs", job.id + ".json");
    await atomicJson(file, job);
    try {
      const sent = await adapter.send({
        sessionId: job.sessionId,
        text: placementInstructions(
          job.context,
          this.promptText(job, text, pending.requestId),
        ),
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
      confirmAnswer(accepted, pending.requestId);
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
  promptText(job, text, requestId) {
    if (job.pendingPrompt?.questionId)
      text = `Answer to ${job.pendingPrompt.questionId}:\n${text}\n\nContinue the original task in this same session. Recheck affected files before editing; preserve the recorded model, directories and permissions. This answer does not expand authority.`;
    return job.questionProtocol?.version === 1
      ? `${decisionInstructions(requestId)}\n\n${text}`
      : text;
  }
  async afterWait(adapter, job, result) {
    const backendResult = structuredClone(result);
    // Completion evidence remains readable even when placement later drifts.
    await withJobWriter(this.home, job.id, async () => {
      const latest = await this.receipt({ jobId: job.id });
      if (latest.requestId !== job.requestId) return;
      if (!(latest.backendResult?.completed && !backendResult.completed))
        latest.backendResult = backendResult;
      if (backendResult.completed) {
        delete latest.pendingPrompt;
        confirmAnswer(latest, job.requestId);
      }
      if (latest.state !== "cancellation-requested") {
        Object.assign(result, reconcileDecision(latest, backendResult));
        if (result.needsInput) {
          latest.state = result.status;
          latest.result = result;
        }
      }
      job.questions = latest.questions;
      job.questionError = latest.questionError;
      job.backendResult = latest.backendResult;
      await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
    });
    if (backendResult.completed) delete job.pendingPrompt;
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
        return a.prepare({ jobId: job.id, plan: job.plan });
      });
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
        confirmAnswer(accepted, pending.requestId);
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
    maxQuestions = 5,
  } = {}) {
    if (
      !Number.isInteger(maxQuestions) ||
      maxQuestions < 0 ||
      maxQuestions > 10
    )
      throw new HubError(
        "invalid-question-limit",
        "maxQuestions must be an integer from 0 to 10.",
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
      ...(maxQuestions > 0
        ? { questionProtocol: { version: 1, maxQuestions }, questions: [] }
        : {}),
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
        ...result,
        ...(superseded ? { superseded: true } : {}),
      };
    } catch (error) {
      if (!receipt.sessionId && typeof error.details?.sessionId === "string")
        receipt.sessionId = error.details.sessionId;
      receipt.state = receipt.pendingPrompt
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
  async questions({ jobId } = {}) {
    const job = await this.receipt({ jobId });
    return {
      jobId: job.id,
      target: job.target,
      instance: job.instance,
      sessionId: job.sessionId,
      state: job.state,
      protocol: job.questionProtocol ?? null,
      questions: job.questions ?? [],
      ...(job.questionError ? { questionError: job.questionError } : {}),
    };
  }
  async answer({ jobId, questionId, text } = {}) {
    if (
      typeof questionId !== "string" ||
      !/^question-[a-f0-9]{32}$/.test(questionId)
    )
      throw new HubError(
        "invalid-question-id",
        "Choose a recorded question ID from this job.",
      );
    if (typeof text !== "string" || !text.trim() || text.length > 12000)
      throw new HubError(
        "invalid-answer",
        "An answer must contain 1 to 12000 characters.",
      );
    await this.receipt({ jobId });
    return withJobWriter(this.home, jobId, async () => {
      const { job, selected } = await this.resolveJob(jobId);
      const question = job.questions?.find((q) => q.id === questionId);
      if (!question)
        throw new HubError(
          "question-not-found",
          "This question does not belong to the selected job.",
        );
      if (
        job.state === "cancellation-requested" ||
        question.state === "cancelled"
      )
        throw new HubError(
          "dispatch-cancelled",
          "This task was cancelled. No answer was sent.",
        );
      if (question.answer && question.answer.textHash !== digest(text))
        throw new HubError(
          "answer-conflict",
          "This question already has a different recorded answer. No answer was sent.",
        );
      if (question.state === "answered")
        return {
          jobId,
          target: job.target,
          sessionId: job.sessionId,
          questionId,
          requestId: question.answer.requestId,
          afterSeq: question.answer.afterSeq,
          accepted: true,
          duplicate: true,
          promptSent: false,
        };
      if (question.state === "limit-reached")
        throw new HubError(
          "question-limit-reached",
          "This job reached its question limit. Inspect it and explicitly cancel or start a new task.",
        );
      this.checkPromptPolicy(job, selected, text);
      const isPending = question.state === "answer-pending";
      if (isPending) {
        if (
          job.requestId !== question.answer?.requestId ||
          job.pendingPrompt?.questionId !== questionId
        )
          throw new HubError(
            "answer-admission-uncertain",
            "The original answer admission remains uncertain. Inspect its receipt; no answer was resent.",
          );
      } else if (
        question.state !== "open" ||
        question.requestId !== job.requestId ||
        job.pendingPrompt
      ) {
        throw new HubError(
          "question-stale",
          "This question is no longer awaiting an answer on the current request.",
        );
      }
      return this.withAdapter(selected, async (a) => {
        await a.assertInstance(job.instance);
        const verified = await a.verify({ jobId, sessionId: job.sessionId });
        assertContext(verified.context, job.context);
        let result;
        if (isPending) {
          result = await a.confirmPrompt({
            sessionId: job.sessionId,
            requestId: job.requestId,
            afterSeq: job.afterSeq,
          });
          if (
            !result.accepted ||
            result.requestId !== job.requestId ||
            result.afterSeq !== job.afterSeq
          )
            throw new HubError(
              "answer-admission-uncertain",
              "The original answer is not confirmed. No prompt was resent; keep waiting on this job.",
            );
          confirmAnswer(job, job.requestId);
          delete job.pendingPrompt;
          delete job.promptError;
          job.state = "accepted";
          await atomicJson(join(this.home, "jobs", job.id + ".json"), job);
        } else {
          result = await this.sendRecorded(a, job, text, {
            answerQuestion: question,
          });
        }
        return {
          jobId,
          target: job.target,
          sessionId: job.sessionId,
          questionId,
          ...result,
          ...(isPending ? { duplicate: true, promptSent: false } : {}),
        };
      });
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
          this.checkPromptPolicy(current, target, text);
          if (current.state === "cancellation-requested")
            throw new HubError(
              "dispatch-cancelled",
              "This task was cancelled. No follow-up was sent.",
            );
          if (pendingQuestion(current))
            throw new HubError(
              "question-pending",
              "Answer the recorded question with answer/hub_answer before sending follow-up work.",
            );
          if (current.questions?.some((q) => q.state === "limit-reached"))
            throw new HubError(
              "question-limit-reached",
              "Inspect this job's question limit before starting a new task.",
            );
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
      } else {
        latest.state = "cancellation-requested";
        for (const question of latest.questions ?? [])
          if (question.state === "open") question.state = "cancelled";
      }
      await atomicJson(join(this.home, "jobs", job.id + ".json"), latest);
      return { jobId: job.id, target: job.target, ...result };
    });
  }
}
