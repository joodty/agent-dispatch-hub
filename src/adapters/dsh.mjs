import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { dependencyPath } from "../core/dependencies.mjs";
import { readJson, HubError } from "../core/state.mjs";

export async function createDshAdapter(
  target,
  { home, clientModule, fetchImpl = fetch } = {},
) {
  const module =
    clientModule ??
    (await import(
      pathToFileURL(
        join(await dependencyPath(home, "bridge"), "scripts/dsh-client.mjs"),
      ).href
    ));
  const env = {};
  const connection = target.connection;
  if (connection.kind === "local") {
    if (typeof connection.connectionFile !== "string")
      throw new HubError(
        "invalid-target",
        "Local DSH needs an explicit companion connection file.",
      );
    env.DSH_BRIDGE_CONNECTION_FILE = connection.connectionFile;
  } else if (connection.kind === "remote") {
    let origin;
    try {
      origin = new URL(connection.baseUrl);
    } catch {
      throw new HubError(
        "invalid-target",
        "Remote DSH requires a valid HTTPS origin.",
      );
    }
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    )
      throw new HubError(
        "invalid-target",
        "Remote DSH requires a clean HTTPS origin.",
      );
    let credential;
    try {
      credential = await readJson(connection.credentialFile);
    } catch {
      throw new HubError(
        "pairing-required",
        "Pair the selected remote target before dispatch.",
      );
    }
    if (credential.version !== 1 || credential.origin !== origin.origin)
      throw new HubError(
        "credential-mismatch",
        "Credential does not belong to the selected DSH origin. Pair this target again.",
      );
    env.DSH_ALLOW_REMOTE = "true";
    env.DSH_BASE_URL = origin.origin;
    if (typeof credential.cookie === "string" && credential.cookie)
      env.DSH_BRIDGE_COOKIE = credential.cookie;
    else if (typeof credential.token === "string" && credential.token)
      env.DSH_BRIDGE_TOKEN = credential.token;
    else
      throw new HubError(
        "pairing-required",
        "Pair the selected remote target before dispatch.",
      );
  } else
    throw new HubError(
      "invalid-target",
      "DSH connection kind must be local or remote.",
    );
  const client = new module.DshClient({
    env,
    configPath: join(home, "targets", target.name, "bridge-settings.json"),
  });
  const control = async (
    operation,
    params = {},
    instance = target.instance,
  ) => {
    if (!client.localAuth)
      throw new HubError(
        "companion-required",
        "Placement v2 requires an authenticated DSH connection and the Agent Dispatch Hub companion.",
      );
    let response;
    try {
      response = await fetchImpl(
        new URL("/plugins/agent-dispatch-hub/v2/control", client.baseUrl),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            "content-type": "application/json",
            ...(await client.localAuth.headers()),
          },
          body: JSON.stringify({
            operation,
            ...(instance ? { instanceId: instance.id } : {}),
            params,
          }),
        },
      );
    } catch {
      throw new HubError(
        "companion-unreachable",
        "Cannot reach the selected DSH placement companion. Check its connection and readiness.",
      );
    }
    if (response.status === 404)
      throw new HubError(
        "companion-required",
        "Install and load the Agent Dispatch Hub placement v2 companion on the selected DSH instance.",
      );
    if ([401, 403].includes(response.status))
      throw new HubError(
        "authentication-required",
        "The selected DSH rejected companion authentication. Check or pair this specific target.",
      );
    let body;
    try {
      const text = await response.text();
      if (text.length > 1024 * 1024) throw Error();
      body = JSON.parse(text);
    } catch {
      throw new HubError(
        "invalid-companion-response",
        "The selected companion did not return a valid bounded response.",
      );
    }
    if (!response.ok || body.ok !== true) {
      const code = /^[a-z][a-z0-9-]{1,70}$/.test(body.error?.code ?? "")
        ? body.error.code
        : "placement-rejected";
      throw new HubError(
        code,
        "The selected companion rejected the placement operation. Inspect the target workspace, directories, instance binding and explicit creation policy.",
        {
          ...(typeof body.error?.sessionId === "string" &&
          /^session-[a-f0-9-]{36}$/.test(body.error.sessionId)
            ? { sessionId: body.error.sessionId }
            : {}),
        },
      );
    }
    return body.value;
  };
  return {
    status: () => client.describe(),
    dispatch: (args) => client.dispatch(args),
    inspect: () => control("inspect", {}, null),
    assertInstance: async (instance) => {
      const result = await control("inspect", {}, null);
      if (
        result.protocolVersion !== 2 ||
        result.instance?.id !== instance?.id ||
        result.instance?.pathStyle !== instance?.pathStyle
      )
        throw new HubError(
          "instance-mismatch",
          "The authenticated endpoint is not the DSH instance captured by this target. No task was sent.",
        );
      return result;
    },
    prepare: (args) => control("prepare", args),
    verify: (args) => control("verify", args),
    beginRun: (args) => control("beginRun", args),
    finishRun: (args) => control("finishRun", args),
    changes: (args) => control("changes", args),
    observeLegacy: (args) => control("observeLegacy", args),
    cursor: async ({ sessionId }) => ({
      afterSeq: (await client.getMessages({ sessionId, maxMessages: 1 }))
        .latestSeq,
    }),
    confirmPrompt: async ({ sessionId, requestId, afterSeq }) => {
      const history = await client.getMessages({
        sessionId,
        requestId,
        afterSeq,
        maxMessages: 100,
      });
      const logged = history.messages?.some(
        (m) => m.role === "user" && m.requestId === requestId,
      );
      const inbox = history.projections?.values?.inbox;
      const queued =
        inbox &&
        Object.values(inbox).some(
          (items) =>
            Array.isArray(items) &&
            items.some(
              (m) => m.source?.kind === "user" && m.source.rpcId === requestId,
            ),
        );
      return {
        accepted: !!(logged || queued),
        sessionId,
        requestId,
        afterSeq,
        promptSent: false,
      };
    },
    send: async ({ sessionId, text, requestId, afterSeq }) => {
      if (typeof requestId !== "string" || !Number.isInteger(afterSeq))
        throw new HubError(
          "invalid-prompt-admission",
          "A durable request ID and history cursor are required before sending.",
        );
      const value = await client.rpc("session.prompt", {
        requestId,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      return { ...value, sessionId, requestId, afterSeq };
    },
    wait: (args) => client.waitForSession(args),
    messages: (args) => client.getMessages(args),
    cancel: (args) => client.cancelSession(args),
    readArtifact: (args) =>
      args.jobId ? control("readArtifact", args) : client.readArtifact(args),
    close: () => client.close(),
  };
}
