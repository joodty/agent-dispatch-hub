import { access, open } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  absolute,
  checked,
  defaultRunner,
  installError,
  userPath,
  windowsInventory,
} from "./shared.mjs";

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
export function nativeExeFromCli(cli) {
  return /[\\/]resources[\\/]runtime[\\/]cli[\\/]bin[\\/]dsh\.cmd$/iu.test(cli)
    ? resolve(dirname(cli), "../../../..", "DeepSeek Harness.exe")
    : undefined;
}
async function asarVersion(exe) {
  const handle = await open(join(dirname(exe), "resources", "app.asar"), "r");
  try {
    const first = Buffer.alloc(16);
    await handle.read(first, 0, 16, 0);
    const length = first.readUInt32LE(12);
    if (!length || length > 32 * 1024 * 1024)
      throw new Error("invalid archive");
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 16);
    const entry = JSON.parse(bytes.toString()).files?.["package.json"];
    if (!entry?.size || entry.size > 65536) throw new Error("invalid metadata");
    const content = Buffer.alloc(entry.size);
    await handle.read(
      content,
      0,
      content.length,
      8 + first.readUInt32LE(4) + Number(entry.offset),
    );
    const pkg = JSON.parse(content.toString());
    if (pkg.name !== "@deepseek-ai/dsh-desktop")
      throw new Error("different application");
    return pkg.version;
  } finally {
    await handle.close();
  }
}
export function supportedDshVersion(version) {
  const match = /^0\.2\.(\d+)(?:-rc\.(\d+))?$/u.exec(version ?? "");
  return Boolean(
    match &&
    (Number(match[1]) > 1 ||
      (Number(match[1]) === 1 &&
        (match[2] === undefined || Number(match[2]) >= 3))),
  );
}
export async function discoverLocal(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    runner = defaultRunner,
    profile = "desktop",
  } = options;
  if (!/^[A-Za-z0-9_-]+$/u.test(profile))
    throw installError("INVALID_PROFILE", "The DSH profile name is invalid.");
  if (platform !== "win32" && !options.dshCli)
    throw installError(
      "DSH_CLI_REQUIRED",
      "Specify the installed DSH CLI on this platform.",
      { option: "--dsh-cli" },
    );
  const inventory =
    platform === "win32"
      ? (options.inventory ?? (await windowsInventory(runner)))
      : {};
  const configuredHome =
    options.dshHome ??
    [env.DSH_HOME, inventory.userHome, inventory.machineHome].find(
      (value) => typeof value === "string" && value.trim(),
    );
  const dshHome = configuredHome
    ? userPath(configuredHome)
    : join(options.userHome ?? homedir(), ".dsh");
  let dshCli;
  let appExe;
  let version;
  if (options.dshCli || options.dshExe) {
    appExe = options.dshExe ? absolute(options.dshExe, "dshExe") : undefined;
    dshCli = options.dshCli
      ? absolute(options.dshCli, "dshCli")
      : join(dirname(appExe), "resources", "runtime", "cli", "bin", "dsh.cmd");
    appExe ??= nativeExeFromCli(dshCli);
    if (!(await exists(dshCli)) || (appExe && !(await exists(appExe))))
      throw installError(
        "DSH_NOT_FOUND",
        "The specified DSH installation is unavailable.",
        { option: "--dsh-cli or --dsh-exe" },
      );
    if (appExe) {
      try {
        version = await asarVersion(appExe);
      } catch {
        throw installError(
          "DSH_METADATA_INVALID",
          "The native DSH installation metadata could not be verified.",
        );
      }
    }
  } else {
    const runningPaths = (
      Array.isArray(inventory.running) ? inventory.running : [inventory.running]
    ).filter(Boolean);
    const candidates = [
      ...runningPaths,
      ...(options.candidates ?? []),
      ...(env.LOCALAPPDATA
        ? [
            join(
              env.LOCALAPPDATA,
              "Programs",
              "DeepSeek Harness",
              "DeepSeek Harness.exe",
            ),
          ]
        : []),
      ...(Array.isArray(inventory.installs)
        ? inventory.installs
        : [inventory.installs]
      )
        .filter(Boolean)
        .map((path) => join(path, "DeepSeek Harness.exe")),
    ];
    const valid = [];
    for (const candidate of [
      ...new Set(candidates.map((path) => resolve(path))),
    ]) {
      const cli = join(
        dirname(candidate),
        "resources",
        "runtime",
        "cli",
        "bin",
        "dsh.cmd",
      );
      if (!(await exists(candidate)) || !(await exists(cli))) continue;
      try {
        const v = await asarVersion(candidate);
        if (supportedDshVersion(v))
          valid.push({ appExe: candidate, dshCli: cli, version: v });
      } catch {
        /* Ignore stale registry and incomplete installations. */
      }
    }
    const active = valid.filter((item) =>
      runningPaths.some(
        (path) => path.toLowerCase() === item.appExe.toLowerCase(),
      ),
    );
    const choices = active.length ? active : valid;
    if (choices.length !== 1)
      throw installError(
        choices.length ? "DSH_AMBIGUOUS" : "DSH_NOT_FOUND",
        choices.length
          ? "Multiple DSH installations are available; specify one."
          : "A supported native DSH installation was not found.",
        { option: "--dsh-exe or --dsh-cli" },
      );
    ({ appExe, dshCli, version } = choices[0]);
  }
  if (!version) {
    const result = await checked(
      runner,
      dshCli,
      ["--version"],
      { env: { ...env, DSH_HOME: dshHome } },
      "DSH_VERSION_FAILED",
    );
    version = String(result.stdout ?? "").trim();
  }
  if (!supportedDshVersion(version))
    throw installError(
      "DSH_VERSION_UNSUPPORTED",
      "DSH 0.2.1-rc.3 or a compatible 0.2 release is required.",
    );
  const running = Boolean(
    appExe &&
    (Array.isArray(inventory.running) ? inventory.running : [inventory.running])
      .filter(Boolean)
      .some((path) => path.toLowerCase() === appExe.toLowerCase()),
  );
  return {
    dshHome,
    profile,
    profileDir: join(dshHome, "profiles", profile),
    dshCli,
    version,
    ...(appExe ? { appExe } : {}),
    running,
  };
}
