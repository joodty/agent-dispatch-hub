import test from "node:test";
import assert from "node:assert/strict";
import { DshEndpoint } from "../src/team/dsh-endpoint.mjs";
import { fingerprint } from "../src/core/state.mjs";
import { digest } from "../src/core/placement.mjs";
import { apply, definitions } from "../packages/dsh-messaging/lib/index.mjs";

const sessionId = "session-12345678-1234-4234-8234-123456789012";
function fixture(style = "posix") {
  const path = style === "win32" ? "C:\\work" : "/srv/work";
  const mapping = {
    dshWorkspace: { id: "workspace" },
    source: { root: style === "win32" ? "C:\\source" : "/srv/source" }, // release-check:ignore synthetic Windows path fixture
  };
  let target = {
    name: "office",
    adapter: "dsh",
    instance: { id: "instance", pathStyle: style },
    connection: { kind: "remote", baseUrl: "https://example.com" },
    workspaces: { demo: mapping },
  };
  const state = {
    cwd: path + (style === "win32" ? "\\task" : "/task"),
    workspaceId: "workspace",
    sends: [],
  };
  const a = {
    assertInstance: async () => {},
    conversation: async () => ({
      instance: target.instance,
      dshWorkspace: { id: state.workspaceId, path },
      actualCwd: state.cwd,
      initialCwd: path,
      running: false,
      inboxPending: false,
      latestSeq: 10,
    }),
    send: async (args) => {
      state.sends.push(args);
      return args;
    },
    confirmPrompt: async (args) => args,
  };
  const hub = {
    target: async () => target,
    inspect: async () => ({
      instance: target.instance,
      workspaces: [{ id: "workspace" }],
    }),
    withAdapter: async (_t, fn) => fn(a),
  };
  return {
    endpoint: new DshEndpoint({ hub }),
    state,
    changeTarget: () => {
      target = {
        ...target,
        connection: { kind: "remote", baseUrl: "https://other.example.com" },
      };
    },
    path,
  };
}
test("DSH member binds instance and mapping; later connection change cannot reroute a reply", async () => {
  const f = fixture();
  const m = await f.endpoint.bind({
    target: "office",
    workspace: "demo",
    sessionRoots: [f.path],
  });
  const initial = await f.endpoint.observe(m, sessionId);
  assert.equal(initial.frozen.actualCwd, "/srv/work/task");
  f.changeTarget();
  await assert.rejects(f.endpoint.observe(m, sessionId), {
    code: "team-target-changed",
  });
  assert.equal(f.state.sends.length, 0);
});
test("workspace and cwd drift reject the original session instead of silently using another", async () => {
  const f = fixture();
  const m = await f.endpoint.bind({
    target: "office",
    workspace: "demo",
    sessionRoots: [f.path],
  });
  const original = await f.endpoint.observe(m, sessionId);
  f.state.workspaceId = "other";
  await assert.rejects(f.endpoint.observe(m, sessionId), {
    code: "team-session-outside-scope",
  });
  f.state.workspaceId = "workspace";
  f.state.cwd = "/srv/work-escape";
  await assert.rejects(f.endpoint.observe(m, sessionId), {
    code: "team-session-outside-scope",
  });
  f.state.cwd = "/srv/work/new-task";
  await assert.rejects(f.endpoint.observe(m, sessionId, original.frozen), {
    code: "team-session-changed",
  });
});
test("remote posix and Windows roots use endpoint semantics without local path resolution", async () => {
  const f = fixture("win32");
  const m = await f.endpoint.bind({
    target: "office",
    workspace: "demo",
    sessionRoots: ["c:\\WORK"],
  });
  assert.equal(
    (await f.endpoint.observe(m, sessionId)).actualCwd,
    "C:\\work\\task",
  );
  f.state.cwd = "C:\\workspace"; // release-check:ignore synthetic Windows path fixture
  await assert.rejects(f.endpoint.observe(m, sessionId), {
    code: "team-session-outside-scope",
  });
});
test("native DSH tool uses actual calling session identity and a stable call key", async () => {
  const calls = [],
    client = {
      call: async (...args) => {
        calls.push(args);
        return { id: "message-one", status: "queued" };
      },
    };
  const tool = definitions(client)[0];
  const result = await tool.execute(
    { question: "Help", context: "Context", project: "demo" },
    {
      agent: { id: sessionId },
      callId: "call-one",
      signal: new AbortController().signal,
    },
  );
  assert.equal(calls[0][0].sessionId, sessionId);
  assert.equal(calls[0][0].requestId, "call-one");
  assert.equal(calls[0][2], "demo");
  assert.match(result.notice, /End this turn/);
  await assert.rejects(
    tool.execute({ question: "Help" }, { callId: "call" }),
    /live DSH session/,
  );
});
test("native plugin registers normalized public JSON schemas without changing model or settings", () => {
  const tools = [];
  apply({
    tools: { register: (tool) => tools.push(tool) },
    profileContext: { dir: "/profile" },
  });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].parameters.type, "object");
  assert.deepEqual(tools[0].parameters.required, ["question"]);
  assert.equal(tools[0].parameters.additionalProperties, false);
});
