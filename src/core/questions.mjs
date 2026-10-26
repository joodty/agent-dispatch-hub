// Task question protocol for Agent Dispatch Hub jobs.
//
// A job's final rules include decisionInstructions(); the agent may answer with
// a normal result, or — only for a key ambiguity — with one strict question
// payload. parseDecision() recognizes only the exact shapes that protocol
// allows, so prose, quoted examples, nested blocks and multiple fences are
// never mined for a question.
import { HubError } from "./state.mjs";

const TEXT_LIMIT = 64 * 1024;
const QUESTION_LIMIT = 2000;
const CONTEXT_LIMIT = 6000;
const OPTION_LIMIT = 500;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 5;
const RECOMMENDATION_LIMIT = 1000;
const FENCE_INFO = "adh-question";
const PROTOCOL_KEYS = [
  "adhQuestion",
  "requestId",
  "question",
  "context",
  "options",
  "recommendation",
];
const INVALID_QUESTION = "回答不符合任务提问协议。";

function invalidQuestion() {
  return new HubError("invalid-question", INVALID_QUESTION);
}

function characterCount(value) {
  return Array.from(value).length;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function protocolStart(value) {
  return /^\{\s*"adhQuestion"\s*:/.test(value);
}

function textValue(value, limit) {
  if (typeof value !== "string" || characterCount(value) > limit)
    throw invalidQuestion();
  return value;
}

/** Read one decoded protocol object, rejecting anything outside the contract. */
function readDecision(object, requestId) {
  for (const key of Object.keys(object))
    if (!PROTOCOL_KEYS.includes(key)) throw invalidQuestion();
  for (const key of ["adhQuestion", "requestId", "question"])
    if (!Object.hasOwn(object, key)) throw invalidQuestion();
  if (object.adhQuestion !== 1) throw invalidQuestion();
  if (
    typeof requestId !== "string" ||
    requestId === "" ||
    object.requestId !== requestId
  )
    throw invalidQuestion();

  const question = textValue(object.question, QUESTION_LIMIT);
  if (question.trim() === "") throw invalidQuestion();

  const decision = { question };
  if (Object.hasOwn(object, "context"))
    decision.context = textValue(object.context, CONTEXT_LIMIT);
  if (Object.hasOwn(object, "options")) {
    const options = object.options;
    if (
      !Array.isArray(options) ||
      options.length < OPTIONS_MIN ||
      options.length > OPTIONS_MAX
    )
      throw invalidQuestion();
    decision.options = options.map((option) => {
      if (typeof option !== "string" || option.trim() === "")
        throw invalidQuestion();
      if (characterCount(option) > OPTION_LIMIT) throw invalidQuestion();
      return option;
    });
  }
  if (Object.hasOwn(object, "recommendation"))
    decision.recommendation = textValue(
      object.recommendation,
      RECOMMENDATION_LIMIT,
    );
  return decision;
}

/**
 * Collect top-level fenced blocks. A closing marker repeats the opening marker
 * and carries no info string; an inner look-alike stays content, so a nested
 * example is never promoted to a protocol payload.
 */
function scanFences(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (open) {
      if (
        match &&
        match[1][0] === open.marker &&
        match[1].length >= open.length &&
        match[2].trim() === ""
      ) {
        blocks.push({
          info: open.info,
          start: open.start,
          end: index,
          content: lines.slice(open.start + 1, index).join("\n"),
        });
        open = null;
      }
      continue;
    }
    if (!match) continue;
    if (match[1][0] === "`" && match[2].includes("`")) continue;
    open = {
      marker: match[1][0],
      length: match[1].length,
      info: match[2].trim(),
      start: index,
    };
  }
  return { lines, blocks, open };
}

/** True when any non-blank line sits outside the top-level fenced blocks. */
function hasOutsideContent({ lines, blocks, open }) {
  const inside = new Set();
  for (const block of blocks)
    for (let index = block.start; index <= block.end; index += 1)
      inside.add(index);
  if (open)
    for (let index = open.start; index < lines.length; index += 1)
      inside.add(index);
  return lines.some((line, index) => !inside.has(index) && line.trim() !== "");
}

/** Short final-answer rules for one dispatched request. */
export function decisionInstructions(requestId) {
  const payload = JSON.stringify({
    adhQuestion: 1,
    requestId,
    question: "需要确认的问题",
    context: "必要的发现",
    options: ["A", "B"],
    recommendation: "建议",
  });
  return [
    "普通细节自行处理，不要为它们停止或提问。",
    "只有遇到缺少必要信息的阻塞，或会改变业务方向、范围或兼容性的关键歧义时，才停止使用工具和修改文件，并把本次任务的唯一最终回复设为下面这一行 JSON：",
    payload,
    `也可以只把同一 JSON 放进一个 ${FENCE_INFO} 代码围栏，不附加其他说明。question 必填；context、options（2-5 个）、recommendation 可省略。`,
    "提问不是授权：不能自行扩大授权范围、修改范围或代替用户决定。请使用此回复协议向负责人求助，不要使用 ask_user_question。",
  ].join("\n");
}

/**
 * Return a question decision, or null for an ordinary final answer.
 * Only one whole JSON payload or one whole adh-question fence is accepted;
 * any clear protocol attempt that is malformed throws invalid-question.
 */
export function parseDecision(text, requestId) {
  if (typeof text !== "string") return null;
  if (Buffer.byteLength(text, "utf8") > TEXT_LIMIT) {
    // The question protocol must not turn an unrelated long result into an
    // error. Reject only an explicitly marked oversized protocol candidate.
    const prefix = text.trimStart();
    if (
      protocolStart(prefix) ||
      /^\s*(`{3,}|~{3,})adh-question(?:\s|$)/.test(prefix)
    )
      throw invalidQuestion();
    return null;
  }
  const value = text.trim();
  if (value === "") return null;

  // A whole JSON document: only this exact position can carry the payload.
  if (value.startsWith("{") && value.endsWith("}")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      if (protocolStart(value)) throw invalidQuestion();
      return null;
    }
    if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "adhQuestion"))
      return null;
    return readDecision(parsed, requestId);
  }

  const fenced = scanFences(value);
  const adhBlocks = fenced.blocks.filter((block) => block.info === FENCE_INFO);
  const openAdh = fenced.open?.info === FENCE_INFO;
  if (adhBlocks.length === 0 && !openAdh) {
    // An unlabelled or json-labelled fence is ordinary output, even when its
    // body looks like a payload; nothing is inferred from it.
    if (protocolStart(value)) throw invalidQuestion();
    return null;
  }
  // Prose around a fenced example makes the reply an ordinary answer.
  if (hasOutsideContent(fenced)) return null;
  if (openAdh) throw invalidQuestion();
  // Multiple top-level fences are ambiguous, so no question is extracted.
  if (fenced.blocks.length !== 1 || adhBlocks.length !== 1) return null;

  const block = adhBlocks[0];
  if (block.start !== 0 || block.end !== fenced.lines.length - 1) return null;
  const body = block.content.trim();
  if (body === "") throw invalidQuestion();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalidQuestion();
  }
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "adhQuestion"))
    throw invalidQuestion();
  return readDecision(parsed, requestId);
}
