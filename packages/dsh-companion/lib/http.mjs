export const CONTROL_PATH = "/plugins/agent-dispatch-hub/v2/control";
export function handlerFor(ctx, service) {
  return async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    const admission = ctx.connection.admit(request);
    if ("rejection" in admission || admission.peer?.principal?.kind !== "owner")
      return reply(403, {
        ok: false,
        error: { code: "authentication-required" },
      });
    if (request.method !== "POST")
      return reply(405, { ok: false, error: { code: "method-not-allowed" } });
    try {
      let size = 0,
        chunks = [];
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 65536) {
          const e = new Error();
          e.code = "request-too-large";
          throw e;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(
        Buffer.concat(chunks.map((x) => Buffer.from(x))).toString("utf8"),
      );
      if (
        ![
          "inspect",
          "prepare",
          "verify",
          "readArtifact",
          "observeLegacy",
        ].includes(body.operation)
      ) {
        const e = new Error();
        e.code = "invalid-operation";
        throw e;
      }
      if (
        body.operation !== "inspect" &&
        body.instanceId !== service.instance.id
      ) {
        const e = new Error();
        e.code = "instance-mismatch";
        throw e;
      }
      let value;
      if (body.operation === "observeLegacy") {
        const sessionId = body.params?.sessionId;
        if (
          typeof sessionId !== "string" ||
          !/^session-[a-f0-9-]{36}$/.test(sessionId)
        ) {
          const e = new Error();
          e.code = "invalid-session";
          throw e;
        }
        const observed = await service.runtime.observeSession(sessionId);
        const workspaces = (await service.runtime.listWorkspaces()).filter(
          (w) => w.sessionIds.includes(sessionId),
        );
        if (workspaces.length > 1) {
          const e = new Error();
          e.code = "workspace-ambiguous";
          throw e;
        }
        value = {
          instance: service.instance,
          ...observed,
          dshWorkspace: workspaces[0] ?? null,
        };
      } else value = await service[body.operation](body.params ?? {});
      reply(200, { ok: true, value });
    } catch (error) {
      const code = /^[a-z][a-z0-9-]{1,70}$/.test(error.code ?? "")
        ? error.code
        : "placement-failed";
      const sessionId = error.sessionId ?? error.details?.sessionId;
      reply(400, {
        ok: false,
        error: {
          code,
          ...(typeof sessionId === "string" &&
          /^session-[a-f0-9-]{36}$/.test(sessionId)
            ? { sessionId }
            : {}),
        },
      });
    }
  };
}
