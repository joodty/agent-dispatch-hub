import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  copyFile,
} from "node:fs/promises";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export function installError(code, message, needsInput, details) {
  const error = new Error(message);
  error.code = code;
  if (needsInput) error.needsInput = needsInput;
  if (details) error.details = details;
  return error;
}
export function absolute(value, label = "path") {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value))
    throw installError("INVALID_PATH", `${label} must be an absolute path.`);
  return resolve(value);
}
export function userPath(value) {
  if (value === "~") return homedir();
  if (/^~[\\/]/u.test(value)) return join(homedir(), value.slice(2));
  return resolve(value);
}
export async function defaultRunner(command, args, options = {}) {
  // .cmd launchers require cmd.exe on Windows. Pass arguments as an argv array
  // to a small PowerShell bridge rather than concatenate user-controlled shell text.
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const payload = Buffer.from(JSON.stringify({ command, args })).toString(
      "base64",
    );
    const script = `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; & $p.command @($p.args); exit $LASTEXITCODE`;
    return defaultRunner(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      options,
    );
  }
  try {
    const result = await exec(command, args, {
      ...options,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 240000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: "",
      exitCode: typeof error.code === "number" ? error.code : 1,
    };
  }
}
export async function checked(
  runner,
  command,
  args,
  options,
  code = "COMMAND_FAILED",
) {
  let result;
  try {
    result = await runner(command, args, options);
  } catch {
    throw installError(
      code,
      "A setup command failed. No command output was retained.",
    );
  }
  if ((result?.exitCode ?? result?.code ?? 0) !== 0)
    throw installError(
      code,
      "A setup command failed. No command output was retained.",
    );
  return result ?? {};
}
export async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw installError("FILE_UNREADABLE", "A setup file could not be read.");
  }
}
export async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function backup(path) {
  if ((await readOptional(path)) === undefined) return undefined;
  const destination = `${path}.adh-backup-${Date.now()}-${randomUUID()}`;
  await copyFile(path, destination);
  return destination;
}
export async function windowsInventory(runner = defaultRunner) {
  const script = `$apps = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ExecutablePath -Unique); $keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); $installs = @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation -Unique); @{ running = $apps; installs = $installs; userHome = [Environment]::GetEnvironmentVariable('DSH_HOME','User'); machineHome = [Environment]::GetEnvironmentVariable('DSH_HOME','Machine') } | ConvertTo-Json -Compress`;
  const result = await runner(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {},
  );
  if ((result?.exitCode ?? result?.code ?? 0) !== 0) return {};
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return {};
  }
}
