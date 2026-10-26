import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { stateHome, HubError } from "../core/state.mjs";
import { TeamService } from "./service.mjs";
import { TeamScheduler } from "./scheduler.mjs";
import { startTeamServer } from "./http.mjs";

export async function runTeamCli(argv) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      ...Object.fromEntries(
        [
          "home",
          "file",
          "member",
          "message",
          "project",
          "port",
          "profile-directory",
          "max-calls",
        ].map((k) => [k, { type: "string" }]),
      ),
    },
  });
  const service = new TeamService({ home: stateHome(v.home) }),
    scheduler = new TeamScheduler({ service });
  const print = (x) => console.log(JSON.stringify(x, null, 2));
  if (v.help || !p.length) {
    print({
      usage: "node bin/adh.mjs team <command> [options]",
      commands: {
        configure: "--file <team-config.json>",
        members: "List configured projects/members without credentials",
        send: "--file <message.json>",
        receipt: "--message message-...",
        messages: "[--project name]",
        "run-once": "Process one queued request or reply",
        recover: "--message message-...; no new model request",
        enable: "--project name",
        disable: "--project name; stop new starts and replies",
        budget:
          "--project name --max-calls 20; explicit owner-only total call limit",
        serve: "[--port 0]; loopback inbox and scheduler, Ctrl+C to stop",
        "install-dsh":
          "--member name --profile-directory <selected-local-DSH-profile>",
      },
      globalOptions: ["--home <protected-state-directory>", "--help"],
    });
    return;
  }
  if (p.length !== 1)
    throw new HubError(
      "invalid-team-command",
      "Use team configure|members|send|receipt|messages|run-once|recover|enable|disable|serve|install-dsh.",
    );
  const input = async () =>
    JSON.parse((await readFile(v.file, "utf8")).replace(/^\uFEFF/, ""));
  if (p[0] === "configure") print(await service.configure(await input()));
  else if (p[0] === "members") print(await service.members());
  else if (p[0] === "send") print(await service.send(await input()));
  else if (p[0] === "receipt")
    print(await service.receipt({ messageId: v.message }));
  else if (p[0] === "messages")
    print(await service.list({ projectId: v.project }));
  else if (p[0] === "run-once") print(await scheduler.tick());
  else if (p[0] === "recover")
    print(await scheduler.recover({ messageId: v.message }));
  else if (p[0] === "budget")
    print(
      await service.setBudget({
        projectId: v.project,
        maxCalls: Number(v["max-calls"]),
      }),
    );
  else if (["enable", "disable"].includes(p[0]))
    print(
      await service.setEnabled({
        projectId: v.project,
        enabled: p[0] === "enable",
      }),
    );
  else if (p[0] === "install-dsh") {
    const { installMessaging } = await import("./install.mjs");
    print(
      await installMessaging({
        service,
        memberId: v.member,
        profileDirectory: v["profile-directory"],
      }),
    );
  } else if (p[0] === "serve") {
    const server = await startTeamServer({
      service,
      scheduler,
      port: Number(v.port ?? 0),
    });
    print({
      listening: server.origin,
      connections: server.connections,
      notice:
        "Dedicated advisor processing is active within each project's configured call budget. Ctrl+C stops this server.",
    });
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.close();
  } else throw new HubError("invalid-team-command", "Unknown team command.");
}
