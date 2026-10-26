import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  dirname,
  resolve,
  join,
  isAbsolute,
  win32,
  posix,
  parse,
  relative,
} from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export class HubError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export const run = promisify(execFile);
export function stateHome(value = process.env.ADH_HOME) {
  const path = resolve(value || join(homedir(), ".agent-dispatch-hub"));
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const part = relative(source, path);
  if (
    path === parse(path).root ||
    path === homedir() ||
    part === "" ||
    (!part.startsWith("..") && !isAbsolute(part))
  )
    throw new HubError(
      "invalid-home",
      "Use a dedicated state directory outside this source repository, not a drive root or your entire home directory.",
    );
  for (let directory = path; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git")))
      throw new HubError(
        "invalid-home",
        "Keep hub state and credentials outside every Git work tree.",
      );
    const parent = dirname(directory);
    if (parent === directory) break;
  }
  return path;
}
export function validName(value, label = "name") {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value)
  )
    throw new HubError(
      "invalid-name",
      `Invalid ${label}. Use letters, digits, dot, dash or underscore.`,
    );
  return value;
}
export function absoluteWorkspace(value) {
  if (
    typeof value !== "string" ||
    !(isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value))
  )
    throw new HubError(
      "invalid-workspace",
      "Workspace must be an absolute path on the target machine.",
    );
  return value;
}
export function fingerprint(target) {
  const connection = { ...target.connection };
  for (const key of ["connectionFile", "credentialFile"])
    if (typeof connection[key] === "string")
      connection[key] = resolve(connection[key]);
  if (connection.baseUrl)
    connection.baseUrl = new URL(connection.baseUrl).origin;
  return createHash("sha256")
    .update(JSON.stringify({ adapter: target.adapter, connection }))
    .digest("hex");
}
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new HubError(
      "invalid-state",
      "Cannot read valid JSON from the selected state file.",
      { path },
    );
  }
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const { stdout } = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
    });
    const sid = stdout.match(/S-1-5-21-(?:\d+-){3}\d+/)?.[0];
    if (!sid)
      throw new HubError(
        "private-directory-failed",
        "Cannot identify the current Windows user for the credential directory.",
      );
    await run(
      "icacls.exe",
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      { windowsHide: true },
    );
  }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
export async function loadConfig(home) {
  const config = await readJson(join(home, "config.json"), {
    version: 1,
    targets: {},
  });
  if (
    config.version !== 1 ||
    !config.targets ||
    typeof config.targets !== "object" ||
    Array.isArray(config.targets)
  )
    throw new HubError(
      "invalid-config",
      "Expected config version 1 and named targets.",
    );
  for (const [name, target] of Object.entries(config.targets)) {
    validName(name, "target");
    validName(target.adapter, "adapter");
    if (
      !target.connection ||
      typeof target.connection !== "object" ||
      !target.workspaces ||
      typeof target.workspaces !== "object"
    )
      throw new HubError(
        "invalid-config",
        `Target ${name} needs connection and workspaces.`,
      );
    for (const [key, path] of Object.entries(target.workspaces)) {
      validName(key, "workspace");
      absoluteWorkspace(path);
    }
  }
  return config;
}
export async function addTarget(home, name, target) {
  validName(name, "target");
  const config = await loadConfig(home);
  const previous = config.targets[name];
  if (previous && fingerprint(previous) !== fingerprint(target))
    throw new HubError(
      "target-conflict",
      "Target already has a different connection. Use a new target name to preserve existing jobs.",
    );
  config.targets[name] = {
    ...target,
    workspaces: { ...previous?.workspaces, ...target.workspaces },
  };
  config.defaultTarget ??= name;
  await atomicJson(join(home, "config.json"), config);
  return config;
}
