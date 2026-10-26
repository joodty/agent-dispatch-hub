import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { atomicJson, HubError } from "../core/state.mjs";

export const MESSAGE_PATH = "/team/v1/messages";
export function memberReceipt(message) {
  return {
    id: message.id,
    from: message.from,
    projectId: message.projectId,
    status: message.status,
    createdAt: message.createdAt,
    ...(message.reply ? { reply: message.reply } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.deliveryError ? { deliveryError: message.deliveryError } : {}),
  };
}
export function handlerForTeam(service) {
  return async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    if (req.url !== MESSAGE_PATH || req.method !== "POST")
      return reply(404, { ok: false, error: { code: "not-found" } });
    try {
      const token = req.headers.authorization?.match(
        /^Bearer ([a-zA-Z0-9-]{32,160})$/,
      )?.[1];
      if (!token)
        return reply(403, {
          ok: false,
          error: { code: "authentication-required" },
        });
      const state = await service.store.read();
      const member = Object.values(state.members).find(
        (m) =>
          m.kind === "dsh" &&
          typeof m.token === "string" &&
          m.token.length === token.length &&
          timingSafeEqual(Buffer.from(m.token), Buffer.from(token)),
      );
      if (!member)
        return reply(403, {
          ok: false,
          error: { code: "authentication-required" },
        });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768)
          throw new HubError("message-too-large", "Message exceeds 32 KiB.");
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new HubError("invalid-message", "Invalid message JSON.");
      }
      let value;
      if (body.operation === "send")
        value = await service.send({
          from: member.id,
          sessionId: body.sessionId,
          requestId: body.requestId,
          body: body.body,
        });
      else if (body.operation === "read")
        value = await service.receipt({
          messageId: body.messageId,
          memberId: member.id,
        });
      else throw new HubError("invalid-operation", "Use send or read.");
      reply(200, { ok: true, value: memberReceipt(value) });
    } catch (error) {
      reply(400, {
        ok: false,
        error: {
          code: error instanceof HubError ? error.code : "team-request-failed",
        },
      });
    }
  };
}
export async function startTeamServer({
  service,
  scheduler,
  port = 0,
  intervalMs = 2000,
  autoRun = true,
}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new HubError("invalid-port", "Choose a loopback TCP port.");
  const server = createServer(handlerForTeam(service));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connections = [];
  try {
    const state = await service.store.read();
    for (const m of Object.values(state.members).filter(
      (m) => m.kind === "dsh",
    )) {
      const path = join(service.home, "team", "connections", m.id + ".json");
      await atomicJson(path, {
        version: 1,
        origin,
        memberId: m.id,
        token: m.token,
      });
      connections.push({ memberId: m.id, path });
    }
  } catch (e) {
    server.close();
    throw e;
  }
  let busy = false,
    activeTick;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await scheduler.tick();
    } catch {
      /* durable receipt retains operation state; no automatic resends */
    } finally {
      busy = false;
    }
  };
  const timer = autoRun
    ? setInterval(() => {
        if (!busy) activeTick = tick();
      }, intervalMs)
    : null;
  return {
    origin,
    connections,
    server,
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
      if (busy) await activeTick;
    },
  };
}
