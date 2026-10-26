import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, dirname } from "node:path";
import { PlacementService } from "./service.mjs";
import {
  runtimeFor,
  guardManagedDirectories,
  guardManagedTools,
} from "./runtime.mjs";
import { handlerFor, CONTROL_PATH } from "./http.mjs";
export const inject = [
  "webServer",
  "connection",
  "workspaceRegistry",
  "sessionController",
  "agents",
  "workingDirectory",
  "sessionQuery",
  "profileContext",
  "tools",
];

async function atomic(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export function apply(ctx, config = {}) {
  const stateDir =
    config.stateDirectory ??
    (typeof ctx.profileContext?.dir === "string"
      ? join(ctx.profileContext.dir, ".agent-dispatch-hub-placement")
      : undefined);
  if (
    typeof stateDir !== "string" ||
    !isAbsolute(stateDir) ||
    resolve(stateDir) === parse(stateDir).root
  )
    throw new Error(
      "Configure a dedicated, protected absolute stateDirectory for this DSH profile.",
    );
  ctx.effect(async () => {
    const runtime = runtimeFor(ctx);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const identityPath = join(stateDir, "instance.json");
    let instance;
    try {
      instance = JSON.parse(await readFile(identityPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error("Invalid placement instance identity.");
      instance = {
        id: randomUUID(),
        pathStyle: process.platform === "win32" ? "win32" : "posix",
      };
      await writeFile(identityPath, JSON.stringify(instance), {
        flag: "wx",
        mode: 0o600,
      });
    }
    const service = new PlacementService({
      instance,
      stateDir: join(stateDir, "jobs"),
      runtime,
      snapshotLimits: config.snapshotLimits,
    });
    await service.initialize();
    const unguard = guardManagedDirectories(ctx.workingDirectory, service);
    const unguardTools = guardManagedTools(ctx, service);
    let unroute;
    const connectionPath = join(stateDir, "connection.json");
    const publicationId = randomUUID();
    try {
      for (const record of service.records.values())
        if (
          record.state === "ready" &&
          record.capability === "readonly" &&
          ctx.agents.get(record.sessionId)
        )
          await runtime.configureReadonly(record.sessionId);
      unroute = ctx.webServer.register({
        kind: "exact",
        path: CONTROL_PATH,
        handler: handlerFor(ctx, service),
      });
      const origin = new URL(ctx.webServer.getOrigin());
      // Remote credentials remain a separately paired secret. Only publish a
      // local transport handoff if this host listens on a loopback origin.
      if (["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
        const authenticated = new URL(
          ctx.connection.authenticatedUrl(origin.origin),
        );
        const token = authenticated.searchParams.get("token");
        if (!token)
          throw new Error("DSH did not issue a local companion token.");
        await atomic(connectionPath, {
          version: 1,
          baseUrl: origin.origin,
          token,
          pid: process.pid,
          instanceId: publicationId,
        });
      }
    } catch (e) {
      unroute?.();
      unguard();
      unguardTools();
      runtime.disposeSafety();
      throw e;
    }
    return async () => {
      unroute?.();
      unguard();
      unguardTools();
      runtime.disposeSafety();
      try {
        const published = JSON.parse(await readFile(connectionPath, "utf8"));
        if (published.instanceId === publicationId)
          await unlink(connectionPath);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };
  }, "agent-dispatch-hub: placement v2 admission");
}
