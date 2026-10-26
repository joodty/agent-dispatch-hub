#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  stateHome,
  loadConfig,
  addTarget,
  atomicJson,
  privateDirectory,
  validName,
  absoluteWorkspace,
  HubError,
  run,
  fingerprint,
} from "../src/core/state.mjs";
import {
  bootstrap,
  dependencyPath,
  dependencyLock,
  repoRoot,
} from "../src/core/dependencies.mjs";
import { Hub } from "../src/core/hub.mjs";
import { pairTarget } from "../src/core/pair.mjs";
import {
  discoverLocal,
  installDshCompanions,
  registerCodexMcp,
} from "../src/install/index.mjs";

const strings = [
  "home",
  "target",
  "url",
  "dsh-home",
  "profile",
  "dsh-exe",
  "dsh-cli",
  "codex-home",
  "codex-cli",
  "mcp-name",
  "text",
  "text-file",
  "job",
  "timeout-ms",
  "from-file",
];
const options = Object.fromEntries(
  strings.map((key) => [key, { type: "string" }]),
);
options.workspace = { type: "string", multiple: true };
for (const key of ["help", "dry-run", "skip-register"])
  options[key] = { type: "boolean" };
let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch {
  console.log(
    JSON.stringify({
      ok: false,
      error: {
        code: "invalid-arguments",
        message:
          "Invalid arguments. Run --help; sensitive input must use stdin or a protected file.",
      },
    }),
  );
  process.exit(2);
}
const { values: v, positionals: p } = parsed;
const home = stateHome(v.home);
const hub = new Hub({ home });
const print = (value) => console.log(JSON.stringify(value, null, 2));
const timeout = () => {
  const value = Number(v["timeout-ms"] ?? 55000);
  if (!Number.isInteger(value) || value < 1000 || value > 300000)
    throw new HubError("invalid-timeout", "Timeout must be 1000–300000 ms.");
  return value;
};
const workspaceMap = () => {
  if (!v.workspace?.length)
    throw new HubError(
      "workspace-required",
      "Supply --workspace name=/absolute/path/on/target.",
    );
  return Object.fromEntries(
    v.workspace.map((value) => {
      const i = value.indexOf("=");
      if (i < 1)
        throw new HubError(
          "invalid-workspace",
          "Expected --workspace name=/absolute/path/on/target.",
        );
      return [
        validName(value.slice(0, i), "workspace"),
        absoluteWorkspace(value.slice(i + 1)),
      ];
    }),
  );
};
const taskText = async () =>
  v["text-file"] ? await readFile(resolve(v["text-file"]), "utf8") : v.text;
async function stdinText() {
  if (process.stdin.isTTY)
    process.stderr.write(
      "Paste the authenticated DSH launch URL, then end input (Ctrl+Z Enter on Windows; Ctrl+D on macOS/Linux). Input is not logged by the hub.\n",
    );
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 16384)
      throw new HubError(
        "input-too-large",
        "Pairing input exceeds its size limit.",
      );
  }
  return value.trim();
}
async function register() {
  return v["skip-register"]
    ? { skipped: true }
    : registerCodexMcp({
        repoRoot,
        home,
        codexHome: v["codex-home"],
        codexCli: v["codex-cli"],
        mcpName: v["mcp-name"],
      });
}
const help = {
  name: "agent-dispatch-hub",
  version: "0.1.0",
  usage: "node bin/adh.mjs <command> [options]",
  commands: {
    doctor: "Inspect local readiness without dispatch or remote contact",
    bootstrap: "Fetch exact dependency pins; do not install DSH plugins",
    "setup local":
      "--target office --workspace demo=/local/path [--dsh-home path --profile desktop --dsh-exe path --codex-home path --dry-run]",
    "setup remote":
      "--target home --url https://dsh.example.com --workspace demo=/remote/path [--codex-home path --dry-run]",
    "target list": "List names and workspace names; no secrets",
    "target use": "target use office",
    "target pair":
      "target pair home [--from-file protected-launch-url.txt]; otherwise reads stdin",
    status: "[--target office]",
    dispatch:
      '--target office --workspace demo --text "task" [--timeout-ms 55000]',
    send: '--job job-... --text "follow-up"',
    wait: "--job job-... [--timeout-ms 55000]",
    messages: "--job job-...",
    cancel: "--job job-...",
    smoke:
      "--target office --workspace demo (actual model request; creates one isolated artifact directory)",
    mcp: "Start MCP stdio server",
  },
  globalOptions: ["--home <user-state-directory>", "--help"],
};

async function main() {
  if (v.help || !p.length) {
    print(help);
    return;
  }
  if (p[0] === "mcp") {
    const { startMcp } = await import("../src/mcp.mjs");
    await startMcp(home);
    return;
  }
  if (p[0] === "doctor") {
    let git;
    try {
      git = (
        await run("git", ["--version"], { windowsHide: true })
      ).stdout.trim();
    } catch {
      git = null;
    }
    const dependencies = {};
    const lock = await dependencyLock();
    for (const name of Object.keys(lock.sources)) {
      try {
        dependencies[name] = {
          ready: true,
          path: await dependencyPath(home, name),
        };
      } catch (error) {
        dependencies[name] = {
          ready: false,
          code: error.code ?? "dependency-missing",
        };
      }
    }
    let targets;
    try {
      targets = await hub.targets();
    } catch (error) {
      targets = { ready: false, code: error.code ?? "invalid-config" };
    }
    print({
      version: "0.1.0",
      node: process.version,
      nodeSupported: Number(process.versions.node.split(".")[0]) >= 22,
      git,
      home,
      dependencies,
      ...targets,
    });
    return;
  }
  if (p[0] === "bootstrap") {
    await privateDirectory(home);
    print(await bootstrap(home));
    return;
  }
  if (p[0] === "target") {
    if (p[1] === "list") {
      print(await hub.targets());
      return;
    }
    if (p[1] === "use") {
      const selected = await hub.target(p[2]);
      const config = await loadConfig(home);
      config.defaultTarget = selected.name;
      await atomicJson(join(home, "config.json"), config);
      print({ defaultTarget: selected.name });
      return;
    }
    if (p[1] === "pair") {
      const name = validName(p[2], "target");
      const input = v["from-file"]
        ? await readFile(resolve(v["from-file"]), "utf8")
        : await stdinText();
      print(await pairTarget(home, name, input));
      return;
    }
    throw new HubError(
      "unknown-command",
      "Use target list, target use <name>, or target pair <name>.",
    );
  }
  if (p[0] === "setup") {
    const targetName = validName(v.target, "target");
    const workspaces = workspaceMap();
    // Validate conflicts before touching either application's settings.
    const config = await loadConfig(home);
    if (p[1] === "remote") {
      let url;
      try {
        url = new URL(v.url);
      } catch {
        throw new HubError(
          "invalid-target",
          "Supply a valid --url HTTPS origin.",
        );
      }
      if (
        url.protocol !== "https:" ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new HubError(
          "invalid-target",
          "Remote URL must be a clean HTTPS origin.",
        );
      const target = {
        adapter: "dsh",
        connection: {
          kind: "remote",
          baseUrl: url.origin,
          credentialFile: join(home, "credentials", targetName + ".json"),
        },
        workspaces,
      };
      if (
        config.targets[targetName] &&
        fingerprint(config.targets[targetName]) !== fingerprint(target)
      )
        throw new HubError(
          "target-conflict",
          "Use a new target name for this different connection.",
        );
      if (v["dry-run"]) {
        print({
          dryRun: true,
          target: targetName,
          connectionKind: "remote",
          baseUrl: url.origin,
          workspaces,
          remoteChanges: false,
          pairingRequired: true,
        });
        return;
      }
      await privateDirectory(home);
      await bootstrap(home);
      await addTarget(home, targetName, target);
      print({
        target: targetName,
        remoteChanges: false,
        pairingRequired: true,
        mcp: await register(),
      });
      return;
    }
    if (p[1] !== "local")
      throw new HubError("unknown-command", "Use setup local or setup remote.");
    const found = await discoverLocal({
      dshHome: v["dsh-home"],
      profile: v.profile ?? "desktop",
      dshExe: v["dsh-exe"],
      dshCli: v["dsh-cli"],
    });
    const target = {
      adapter: "dsh",
      connection: {
        kind: "local",
        connectionFile: join(
          found.dshHome,
          ".codex-dsh-bridge",
          "connection.json",
        ),
      },
      workspaces,
    };
    if (
      config.targets[targetName] &&
      fingerprint(config.targets[targetName]) !== fingerprint(target)
    )
      throw new HubError(
        "target-conflict",
        "Use a new target name for this different connection.",
      );
    if (v["dry-run"]) {
      print({
        dryRun: true,
        ...found,
        target: targetName,
        workspaces,
        actions: [
          "bootstrap pinned dependencies",
          "install DSH companions when changed (native app must be quit)",
          "merge sync deny names",
          "register hub MCP",
          "save local target",
        ],
      });
      return;
    }
    await privateDirectory(home);
    await bootstrap(home);
    await privateDirectory(join(found.dshHome, ".codex-dsh-bridge"));
    const installed = await installDshCompanions({
      ...found,
      codexHome: v["codex-home"],
      mcpNames: [v["mcp-name"] ?? "agent-dispatch-hub"],
      bridgeCheckout: await dependencyPath(home, "bridge"),
      syncCheckout: await dependencyPath(home, "sync"),
    });
    await addTarget(home, targetName, target);
    print({ target: targetName, ...installed, mcp: await register() });
    return;
  }
  if (p[0] === "status") {
    print(await hub.status({ target: v.target }));
    return;
  }
  if (p[0] === "dispatch") {
    const workspace = v.workspace?.[0];
    print(
      await hub.dispatch({
        target: v.target,
        workspace,
        text: await taskText(),
        timeoutMs: timeout(),
      }),
    );
    return;
  }
  if (["send", "wait", "messages", "cancel"].includes(p[0])) {
    print(
      await hub.operate(p[0], {
        jobId: v.job,
        text: p[0] === "send" ? await taskText() : undefined,
        timeoutMs: timeout(),
      }),
    );
    return;
  }
  if (p[0] === "smoke") {
    const { smoke } = await import("../src/core/smoke.mjs");
    print(
      await smoke(hub, {
        target: v.target,
        workspace: v.workspace?.[0],
        timeoutMs: timeout(),
      }),
    );
    return;
  }
  throw new HubError("unknown-command", "Unknown command. Run with --help.");
}
await main().catch((error) => {
  const known =
    error instanceof HubError ||
    (typeof error.code === "string" && /^[A-Z_]+$/.test(error.code));
  const details = Object.fromEntries(
    ["jobId", "target", "sessionId", "option", "configPath", "backupPath"]
      .filter((key) => typeof error.details?.[key] === "string")
      .map((key) => [key, error.details[key]]),
  );
  print({
    ok: false,
    error: {
      code: known ? error.code : "operation-failed",
      message: known
        ? error.message
        : "Operation failed. Check prerequisites, configuration and filesystem access.",
      ...details,
    },
    ...(error.needsInput ? { needsInput: error.needsInput } : {}),
  });
  process.exitCode = 1;
});
