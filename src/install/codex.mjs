import { join } from "node:path";
import { homedir } from "node:os";
import { open, unlink } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import {
  absolute,
  atomicWrite,
  backup,
  checked,
  defaultRunner,
  installError,
  readOptional,
} from "./shared.mjs";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function parseConfig(text) {
  let document;
  try {
    document = text === undefined ? {} : parse(text);
  } catch {
    throw installError(
      "CODEX_CONFIG_INVALID",
      "The existing Codex TOML is invalid; no configuration was changed.",
    );
  }
  if (document.mcp_servers !== undefined && !object(document.mcp_servers))
    throw installError(
      "CODEX_CONFIG_INVALID",
      "The existing Codex MCP configuration is invalid.",
    );
  return document;
}
const sameIdentity = (current, expected) =>
  object(current) &&
  current.command === expected.command &&
  JSON.stringify(current.args ?? []) === JSON.stringify(expected.args);
export async function registerCodexMcp(options = {}) {
  const {
    repoRoot,
    home,
    mcpName = "agent-dispatch-hub",
    runner = defaultRunner,
  } = options;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(mcpName))
    throw installError("INVALID_MCP_NAME", "The MCP name is invalid.");
  const configHome = absolute(
    options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "codexHome",
  );
  const configPath = join(configHome, "config.toml");
  const expected = {
    command: process.execPath,
    args: [
      join(absolute(repoRoot, "repoRoot"), "bin", "adh.mjs"),
      "mcp",
      "--home",
      absolute(home, "home"),
    ],
    startup_timeout_sec: 30,
    tool_timeout_sec: 330,
  };
  const original = await readOptional(configPath);
  let document = parseConfig(original);
  const existing = document.mcp_servers?.[mcpName];
  if (existing !== undefined) {
    if (sameIdentity(existing, expected))
      return { changed: false, configPath, backupPath: undefined };
    throw installError(
      "MCP_NAME_CONFLICT",
      "An MCP server with this name already exists and belongs to another configuration.",
      { option: "--mcp-name" },
    );
  }
  // Create the parent privately before acquiring a lock; never replace a user's
  // existing server, and recheck the exact input under our writer lock.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.adh-lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw installError(
      "CONFIG_BUSY",
      "Another hub setup operation owns the Codex configuration lock.",
    );
  }
  let backupPath;
  try {
    if ((await readOptional(configPath)) !== original)
      throw installError(
        "CONFIG_CHANGED",
        "Codex configuration changed during setup; retry setup.",
      );
    let codexCli = options.codexCli;
    if (codexCli === undefined) {
      try {
        const result = await runner("codex", ["--version"], {});
        if ((result?.exitCode ?? result?.code ?? 0) === 0) codexCli = "codex";
      } catch {
        /* Structured local merge is available without the CLI. */
      }
    }
    backupPath = await backup(configPath);
    if (codexCli) {
      await checked(
        runner,
        codexCli,
        ["mcp", "add", mcpName, "--", expected.command, ...expected.args],
        { env: { ...process.env, CODEX_HOME: configHome } },
        "CODEX_REGISTRATION_FAILED",
      );
      const registered = parseConfig(await readOptional(configPath));
      if (!sameIdentity(registered.mcp_servers?.[mcpName], expected))
        throw installError(
          "CODEX_REGISTRATION_INVALID",
          "Codex did not save the expected MCP registration.",
          undefined,
          { configPath, backupPath },
        );
      registered.mcp_servers[mcpName].startup_timeout_sec ??= 30;
      registered.mcp_servers[mcpName].tool_timeout_sec ??= 330;
      await atomicWrite(configPath, stringify(registered));
      return { changed: true, configPath, backupPath, method: "codex-cli" };
    }
    document.mcp_servers ??= {};
    document.mcp_servers[mcpName] = expected;
    await atomicWrite(configPath, stringify(document));
    return {
      changed: true,
      configPath,
      backupPath,
      method: "toml",
      commentsReformatted: original !== undefined,
    };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
