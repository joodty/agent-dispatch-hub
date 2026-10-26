import { digest } from "./placement.mjs";
import { parseDecision } from "./questions.mjs";

// Only a final assistant message inside this admitted request's completed turn
// may ask a question. Tool output, previous turns and streaming chunks cannot.
function finalText(result, job) {
  if (!result.completed || result.status !== "completed") return null;
  if (result.requestId && result.requestId !== job.requestId) return null;
  const messages = result.messages ?? [];
  const submitted = messages.find(
    (m) =>
      m.role === "user" &&
      m.requestId === job.requestId &&
      Number.isSafeInteger(m.seq) &&
      m.seq > job.afterSeq,
  );
  if (!submitted) return null;
  const terminal = (result.terminalEvents ?? []).find(
    (e) => Number.isSafeInteger(e.seq) && e.seq > submitted.seq,
  );
  if (!terminal || (terminal.reason?.kind ?? "completed") !== "completed")
    return null;
  return (
    messages
      .filter(
        (m) =>
          m.role === "assistant" &&
          Number.isSafeInteger(m.seq) &&
          m.seq > submitted.seq &&
          m.seq < terminal.seq &&
          typeof m.text === "string" &&
          m.text.trim(),
      )
      .at(-1)?.text ?? null
  );
}

export function pendingQuestion(job) {
  return job.questions?.find((q) => q.state === "open");
}

export function confirmAnswer(job, requestId) {
  const question = job.questions?.find(
    (q) => q.answer?.requestId === requestId,
  );
  if (question?.state === "answer-pending") {
    question.state = "answered";
    question.answer.confirmedAt = new Date().toISOString();
  }
}

export function reconcileDecision(job, result) {
  if (job.questionProtocol?.version !== 1) return result;
  const text = finalText(result, job);
  let question = job.questions?.find((q) => q.requestId === job.requestId);
  if (text !== null && !question) {
    try {
      const payload = parseDecision(text, job.requestId);
      if (payload) {
        const limited =
          (job.questions?.length ?? 0) >= job.questionProtocol.maxQuestions;
        question = {
          id:
            "question-" +
            digest({ jobId: job.id, requestId: job.requestId }).slice(0, 32),
          requestId: job.requestId,
          createdAt: new Date().toISOString(),
          state: limited ? "limit-reached" : "open",
          ...payload,
        };
        (job.questions ??= []).push(question);
      }
    } catch {
      job.questionError = {
        code: "invalid-question",
        requestId: job.requestId,
      };
    }
  }
  if (question && ["open", "limit-reached"].includes(question.state)) {
    return {
      ...result,
      backendStatus: result.status,
      status:
        question.state === "open" ? "needs_input" : "question_limit_reached",
      completed: false,
      turnCompleted: true,
      needsInput: true,
      question: structuredClone(question),
    };
  }
  if (job.questionError?.requestId === job.requestId) {
    return {
      ...result,
      backendStatus: result.status,
      status: "question_error",
      completed: false,
      turnCompleted: true,
      needsInput: true,
      questionError: job.questionError,
    };
  }
  return result;
}
