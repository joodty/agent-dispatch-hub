import assert from "node:assert/strict";
import test from "node:test";
import { decisionInstructions, parseDecision } from "../src/core/questions.mjs";
import { HubError } from "../src/core/state.mjs";

const REQUEST = "4f0c3f2e-9a1b-4c5d-8e7f-0123456789ab";
const OTHER = "00000000-0000-4000-8000-000000000000";
const MESSAGE = "回答不符合任务提问协议。";

const payload = (changes = {}) => ({
  adhQuestion: 1,
  requestId: REQUEST,
  question: "成果应写到哪里？",
  ...changes,
});
const asJson = (value, pretty = true) =>
  JSON.stringify(value, null, pretty ? 2 : 0);
const fence = (body, info = "adh-question", marker = "`") =>
  `${marker.repeat(3)}${info}\n${body}\n${marker.repeat(3)}`;

function rejects(fn) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected invalid-question");
  assert.ok(caught instanceof HubError, "expected HubError");
  assert.equal(caught.code, "invalid-question");
  assert.equal(caught.message, MESSAGE);
  return caught;
}

test("decision instructions name the request and keep normal details autonomous", () => {
  const text = decisionInstructions(REQUEST);
  assert.match(text, /普通细节/);
  assert.match(text, /自行处理/);
  assert.match(text, /关键歧义/);
  assert.match(text, /停止使用工具和修改/);
  assert.match(text, /唯一最终回复/);
  assert.match(text, /不能自行扩大授权范围/);
  assert.match(text, /adh-question/);
  for (const key of [
    "adhQuestion",
    "requestId",
    "question",
    "context",
    "options",
    "recommendation",
  ])
    assert.ok(text.includes(`"${key}"`), key);
  const example = text
    .split("\n")
    .find((line) => line.startsWith('{"adhQuestion"'));
  assert.ok(example, "instructions embed one JSON example");
  const decision = parseDecision(example, REQUEST);
  assert.deepEqual(Object.keys(decision).sort(), [
    "context",
    "options",
    "question",
    "recommendation",
  ]);
  assert.equal(decision.options.length, 2);
});

test("a whole JSON payload yields only the question fields", () => {
  const full = payload({
    context: "两次测试都失败。",
    options: ["补充测试", "缩小范围"],
    recommendation: "补充测试",
  });
  assert.deepEqual(parseDecision(asJson(full), REQUEST), {
    question: full.question,
    context: full.context,
    options: full.options,
    recommendation: full.recommendation,
  });
  assert.deepEqual(
    parseDecision(
      asJson(
        { adhQuestion: 1, requestId: REQUEST, question: "只问一句" },
        false,
      ),
      REQUEST,
    ),
    { question: "只问一句" },
  );
  assert.deepEqual(
    parseDecision(`\n  ${asJson(payload(), false)}  \n`, REQUEST),
    {
      question: payload().question,
    },
  );
});

test("one whole adh-question fence yields the same decision", () => {
  const full = payload({ options: ["A", "B"], context: "已确认一处差异。" });
  for (const rendered of [
    fence(asJson(full)),
    fence(asJson(full), "adh-question", "~"),
    fence(asJson(full, false)),
  ])
    assert.deepEqual(parseDecision(rendered, REQUEST), {
      question: full.question,
      context: full.context,
      options: ["A", "B"],
    });
  // Optional fields are omitted from the result, not returned as undefined.
  assert.deepEqual(parseDecision(fence(asJson(payload())), REQUEST), {
    question: payload().question,
  });
});

test("ordinary final answers never produce a question", () => {
  for (const text of [
    "",
    "   \n\t ",
    "已完成改动并通过测试。",
    "普通回答里提到 adhQuestion 这个词也不提问。",
    "```json\n" + asJson(payload()) + "\n```",
    "```\n" + asJson(payload()) + "\n```",
    "```adh-question-example\n" + asJson(payload()) + "\n```",
    asJson({ result: "done", note: "plain" }),
    "结论：\n\n" +
      fence(asJson(payload())) +
      "\n\n以上是提问格式示例，供参考。",
    "示例：\n\n```text\n" +
      fence(asJson(payload())) +
      "\n```\n\n按此格式提问。",
    fence(asJson(payload())) + "\n\n补充说明。",
  ])
    assert.equal(parseDecision(text, REQUEST), null, text.slice(0, 60));
  for (const value of [undefined, null, 42, {}, []])
    assert.equal(parseDecision(value, REQUEST), null);
});

test("another or missing request id is rejected, not mistaken for a decision", () => {
  rejects(() => parseDecision(asJson(payload({ requestId: OTHER })), REQUEST));
  rejects(() =>
    parseDecision(fence(asJson(payload({ requestId: OTHER }))), REQUEST),
  );
  rejects(() =>
    parseDecision(asJson({ adhQuestion: 1, question: "缺少请求号" }), REQUEST),
  );
  rejects(() => parseDecision(fence(asJson(payload())), ""));
  rejects(() => parseDecision(fence(asJson(payload())), OTHER));
});

test("only adhQuestion 1 is accepted", () => {
  for (const value of [2, 0, true, "1", null])
    rejects(() =>
      parseDecision(asJson(payload({ adhQuestion: value })), REQUEST),
    );
  assert.equal(
    parseDecision(
      asJson({ requestId: REQUEST, question: "缺少标记" }),
      REQUEST,
    ),
    null,
  );
});

test("clear protocol attempts with a malformed shape throw invalid-question", () => {
  const attempts = [
    '{"adhQuestion": 1, "requestId": "' + REQUEST + '", "question": "q"',
    '{"adhQuestion": 1, "requestId": "' + REQUEST + '", }',
    asJson(payload()) + " trailing prose",
    fence(""),
    fence("not json"),
    fence('{"adhQuestion": 1'),
    fence(
      '{"adhQuestion": 2, "requestId": "' + REQUEST + '", "question": "q"}',
    ),
    fence(asJson({ requestId: REQUEST, question: "缺少标记" })),
    fence(asJson(payload({ extra: true }))),
    fence(asJson(payload({ question: "   " }))),
    fence(asJson(payload({ question: 7 }))),
    fence(asJson(payload({ context: 7 }))),
    fence(asJson(payload({ options: "A,B" }))),
    fence(asJson(payload({ recommendation: 7 }))),
    "```adh-question\n" + asJson(payload()),
  ];
  for (const text of attempts) rejects(() => parseDecision(text, REQUEST));
});

test("question and context limits count characters", () => {
  assert.equal(
    parseDecision(asJson(payload({ question: "问".repeat(2000) })), REQUEST)
      .question.length,
    2000,
  );
  rejects(() =>
    parseDecision(asJson(payload({ question: "问".repeat(2001) })), REQUEST),
  );
  assert.equal(
    parseDecision(asJson(payload({ context: "背".repeat(6000) })), REQUEST)
      .context.length,
    6000,
  );
  rejects(() =>
    parseDecision(asJson(payload({ context: "背".repeat(6001) })), REQUEST),
  );
});

test("options require 2-5 non-empty strings of at most 500 characters", () => {
  for (const options of [
    ["A", "B"],
    ["A", "B", "C", "D", "E"],
  ])
    assert.deepEqual(
      parseDecision(asJson(payload({ options })), REQUEST).options,
      options,
    );
  for (const options of [
    ["A"],
    ["A", "B", "C", "D", "E", "F"],
    [],
    "A",
    [1, 2],
    ["", "B"],
    ["A", "   "],
    ["A".repeat(501), "B"],
  ])
    rejects(() => parseDecision(asJson(payload({ options })), REQUEST));
  assert.equal(
    parseDecision(asJson(payload({ options: ["A".repeat(500), "B"] })), REQUEST)
      .options[0].length,
    500,
  );
});

test("recommendation is limited to 1000 characters", () => {
  assert.equal(
    parseDecision(
      asJson(payload({ recommendation: "推".repeat(1000) })),
      REQUEST,
    ).recommendation.length,
    1000,
  );
  rejects(() =>
    parseDecision(
      asJson(payload({ recommendation: "推".repeat(1001) })),
      REQUEST,
    ),
  );
});

test("question envelopes are bounded without breaking unrelated long answers", () => {
  assert.equal(parseDecision("x".repeat(64 * 1024), REQUEST), null);
  assert.equal(parseDecision("x".repeat(64 * 1024 + 1), REQUEST), null);
  assert.equal(
    parseDecision(
      "x".repeat(64 * 1024 + 1) + fence(asJson(payload())),
      REQUEST,
    ),
    null,
  );
  rejects(() =>
    parseDecision(asJson(payload({ context: "x".repeat(64 * 1024) })), REQUEST),
  );
  rejects(() =>
    parseDecision(
      fence(asJson(payload({ context: "x".repeat(64 * 1024) }))),
      REQUEST,
    ),
  );
});

test("examples, nesting and multiple fences are never mined for a question", () => {
  const body = asJson(payload());
  const nestedOuter = "```text\n" + fence(body) + "\n```";
  const nestedInner = fence(fence(body));
  const multiple = fence(body) + "\n\n" + fence(body);
  const quoted = "请按下面示例回答：\n\n" + fence(body) + "\n";
  const jsonFence = "```json\n" + body + "\n```";
  for (const text of [nestedOuter, nestedInner, multiple, quoted, jsonFence])
    assert.equal(parseDecision(text, REQUEST), null, text.slice(0, 40));
  // A top-level payload is only accepted as the single whole fence.
  const mixed = fence(body) + "\n```text\n```\n";
  assert.equal(parseDecision(mixed, REQUEST), null);
});
