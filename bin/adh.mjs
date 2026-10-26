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
  placementChecked,
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
  preparePairInput,
  readPairInput,
  consumePairInput,
} from "../src/core/pair-input.mjs";
import {
  discoverLocal,
  installDshCompanions,
  registerCodexMcp,
} from "../src/install/index.mjs";

if (process.argv[2] === "team") {
  try {
    const { runTeamCli } = await import("../src/team/cli.mjs");
    await runTeamCli(process.argv.slice(3));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error: {
          code: error instanceof HubError ? error.code : "team-command-failed",
          message:
            error instanceof HubError
              ? error.message
              : "Team operation failed. Check configuration, credentials and the durable message receipt.",
        },
      }),
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
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
  "mapping-file",
  "path",
  "question-id",
  "max-questions",
];
const options = Object.fromEntries(
  strings.map((key) => [key, { type: "string" }]),
);
options.workspace = { type: "string", multiple: true };
for (const key of ["help", "dry-run", "skip-register", "prepare-input"])
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
    throw new HubError(
      "protected-input-required",
      "Use target pair --prepare-input and --from-file, or pipe protected input through stdin. Interactive terminal input is disabled to avoid echoing the launch URL.",
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
  version: "0.4.0",
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
      "target pair home --prepare-input; then --from-file <protected file outside Git>; otherwise reads stdin",
    "target inspect":
      "target inspect <name>: read selected companion identity, path style and native workspaces",
    "target configure":
      "target configure <name> --mapping-file <JSON containing instance and workspaces> [--dry-run]",
    "legacy-bind":
      "--job job-...: explicitly record a legacy session's original instance; no regrouping or backend mutation",
    verify:
      "--job job-...: verify workspace affiliation and effective cwd through the selected companion",
    artifact:
      "--job job-... --path relative/file.txt: read through the frozen task placement",
    recover:
      "--job job-...: recover an unconfirmed placement using its original job ID; sends no prompt",
    retry:
      "--job job-... --text-file original-task.txt: confirm an uncertain prompt by original request ID and identical text; never resend",
    receipt:
      "--job job-...: read the controller receipt, including retained backend completion after placement drift",
    status: "[--target office]",
    team: "team --help: independent DSH-to-Codex advisor inbox, setup and scheduler",
    dispatch:
      '--target office --workspace demo --text "task" [--timeout-ms 55000 --max-questions 5]',
    send: '--job job-... --text "follow-up"',
    questions:
      "--job job-...: read recorded DSH questions and answer admissions",
    answer:
      '--job job-... --question-id question-... --text "decision": resume the original session; identical repeats never resend',
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
  const expectedCount =
    p[0] === "target" ? (p[1] === "list" ? 2 : 3) : p[0] === "setup" ? 2 : 1;
  if (p.length !== expectedCount)
    throw new HubError(
      "invalid-arguments",
      "Unexpected positional arguments. Quote paths containing spaces and consult --help.",
    );
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
      version: "0.4.0",
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
    if (p[1] === "inspect") {
      print(await hub.inspect({ target: p[2] }));
      return;
    }
    if (p[1] === "configure") {
      const selected = await hub.target(p[2]);
      if (!v["mapping-file"])
        throw new HubError(
          "mapping-file-required",
          "Provide an explicit placement mapping JSON file; no workspace or scope is inferred from a legacy path.",
        );
      const proposal = JSON.parse(
        await readFile(resolve(v["mapping-file"]), "utf8"),
      );
      if (
        !proposal ||
        typeof proposal !== "object" ||
        Array.isArray(proposal) ||
        Object.keys(proposal).some(
          (key) => !["instance", "workspaces"].includes(key),
        )
      )
        throw new HubError(
          "invalid-config",
          "The mapping file must contain only instance and workspaces; copy those fields from the configuration example.",
        );
      const { validateTargetBinding, validateMapping } =
        await import("../packages/dsh-companion/lib/placement.mjs");
      placementChecked(() => validateTargetBinding(proposal.instance));
      if (
        !proposal.workspaces ||
        typeof proposal.workspaces !== "object" ||
        Array.isArray(proposal.workspaces) ||
        !Object.keys(proposal.workspaces).length
      )
        throw new HubError(
          "invalid-config",
          "Provide at least one explicit named placement mapping.",
        );
      for (const [name, mapping] of Object.entries(proposal.workspaces)) {
        validName(name, "workspace");
        placementChecked(() =>
          validateMapping(mapping, proposal.instance.pathStyle),
        );
      }
      const observed = await hub.inspect({ target: selected.name });
      if (
        observed.instance.id !== proposal.instance.id ||
        observed.instance.pathStyle !== proposal.instance.pathStyle
      )
        throw new HubError(
          "instance-mismatch",
          "The selected companion identity differs from the proposed mapping.",
        );
      if (selected.instance && selected.instance.id !== proposal.instance.id)
        throw new HubError(
          "target-conflict",
          "Use a new target name for a different DSH instance; preserve existing jobs.",
        );
      if (v["dry-run"]) {
        print({
          dryRun: true,
          target: selected.name,
          instance: proposal.instance,
          workspaces: proposal.workspaces,
          existingJobsChanged: false,
        });
        return;
      }
      const { backup } = await import("../src/install/shared.mjs");
      const backupPath = await backup(join(home, "config.json"));
      await addTarget(home, selected.name, {
        ...selected,
        instance: proposal.instance,
        workspaces: proposal.workspaces,
      });
      print({
        target: selected.name,
        version: 2,
        backupPath,
        existingJobsChanged: false,
      });
      return;
    }
    if (p[1] === "pair") {
      const name = validName(p[2], "target");
      const target = await hub.target(name);
      if (target.connection.kind !== "remote")
        throw new HubError(
          "invalid-target",
          "Pairing is only for a remote target.",
        );
      if (v["prepare-input"]) {
        print(await preparePairInput(home, name));
        return;
      }
      const input = v["from-file"]
        ? await readPairInput(home, v["from-file"])
        : null;
      const result = await pairTarget(
        home,
        name,
        input ? input.text : await stdinText(),
      );
      await consumePairInput(input);
      print(result);
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
        placementRequired: true,
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
          "profiles",
          found.profile,
          ".agent-dispatch-hub-placement",
          "connection.json",
        ),
      },
      workspaces,
    };
    if (config.targets[targetName]?.connection.kind === "local")
      target.connection.connectionFile =
        config.targets[targetName].connection.connectionFile;
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
      placementCheckout: join(repoRoot, "packages", "dsh-companion"),
    });
    if (installed.placementStateDirectory)
      await privateDirectory(installed.placementStateDirectory);
    await addTarget(home, targetName, target);
    print({
      target: targetName,
      placementRequired: true,
      ...installed,
      mcp: await register(),
    });
    return;
  }
  if (p[0] === "status") {
    print(await hub.status({ target: v.target }));
    return;
  }
  if (p[0] === "legacy-bind") {
    print(await hub.bindLegacy({ jobId: v.job, target: v.target }));
    return;
  }
  if (p[0] === "recover") {
    print(await hub.recover({ jobId: v.job }));
    return;
  }
  if (p[0] === "retry") {
    print(await hub.retryPrompt({ jobId: v.job, text: await taskText() }));
    return;
  }
  if (p[0] === "receipt") {
    print(await hub.receipt({ jobId: v.job }));
    return;
  }
  if (p[0] === "verify") {
    print(await hub.verify({ jobId: v.job }));
    return;
  }
  if (p[0] === "artifact") {
    print(await hub.readArtifact({ jobId: v.job, path: v.path }));
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

        ...(v["max-questions"] === undefined
          ? {}
          : {
              maxQuestions: /^\d+$/.test(v["max-questions"])
                ? Number(v["max-questions"])
                : NaN,
            }),
      }),
    );
    return;
  }
  if (p[0] === "questions") {
    print(await hub.questions({ jobId: v.job }));
    return;
  }
  if (p[0] === "answer") {
    print(
      await hub.answer({
        jobId: v.job,
        questionId: v["question-id"],
        text: await taskText(),
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
    const result = await smoke(hub, {
      target: v.target,
      workspace: v.workspace?.[0],
      timeoutMs: timeout(),
    });
    print(result);
    if (!result.verification.passed) process.exitCode = 2;
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
