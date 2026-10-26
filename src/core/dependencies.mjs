import { readFile, mkdir, rename, mkdtemp, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, readJson, atomicJson, HubError } from "./state.mjs";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export async function dependencyLock() {
  return readJson(join(repoRoot, "dependencies.lock.json"));
}
export async function dependencyPath(home, name, { verify = true } = {}) {
  const lock = await dependencyLock();
  const source = lock.sources[name];
  if (
    !source ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(source.url) ||
    !/^[a-f0-9]{40}$/.test(source.commit)
  )
    throw new HubError(
      "invalid-dependency-pin",
      "Dependency requires a fixed GitHub source and full commit hash.",
    );
  const path = join(home, "dependencies", `${name}-${source.commit}`);
  try {
    await access(path);
  } catch {
    throw new HubError(
      "dependency-missing",
      "Run bootstrap to install the pinned external dependencies.",
      { dependency: name },
    );
  }
  if (verify) {
    const head = (
      await run("git", ["rev-parse", "HEAD"], { cwd: path, windowsHide: true })
    ).stdout.trim();
    if (head !== source.commit)
      throw new HubError(
        "dependency-drift",
        "Cached dependency does not match the pinned commit.",
        { dependency: name },
      );
    const dirty = (
      await run("git", ["diff", "--name-only", "HEAD"], {
        cwd: path,
        windowsHide: true,
      })
    ).stdout.trim();
    if (dirty)
      throw new HubError(
        "dependency-drift",
        "Cached dependency has local edits. Preserve them and restore the pin before use.",
        { dependency: name },
      );
  }
  return path;
}
export function npmCommand(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /npm-cli\.js$/i.test(npmCli))
    return { command: process.execPath, args: [npmCli, ...args] };
  if (process.platform === "win32")
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `npm ${args.join(" ")}`],
    };
  return { command: "npm", args };
}
export async function bootstrap(home) {
  const lock = await dependencyLock();
  const parent = join(home, "dependencies");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const installed = {};
  for (const [name, source] of Object.entries(lock.sources)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(source.url) ||
      !/^[a-f0-9]{40}$/.test(source.commit)
    )
      throw new HubError(
        "invalid-dependency-pin",
        "Invalid dependency source pin.",
      );
    const destination = join(parent, `${name}-${source.commit}`);
    let exists = true;
    try {
      await access(destination);
    } catch {
      exists = false;
    }
    if (!exists) {
      const stage = await mkdtemp(join(parent, `${name}-staging-`));
      const options = {
        cwd: stage,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      };
      try {
        await run("git", ["init"], options);
        await run("git", ["remote", "add", "origin", source.url], options);
        await run(
          "git",
          ["fetch", "--depth", "1", "origin", source.commit],
          options,
        );
        await run("git", ["checkout", "--detach", "FETCH_HEAD"], options);
        const head = (
          await run("git", ["rev-parse", "HEAD"], options)
        ).stdout.trim();
        if (head !== source.commit) throw Error("Pin mismatch");
        const npm = npmCommand([
          "ci",
          "--omit=dev",
          "--ignore-scripts",
          "--legacy-peer-deps",
          "--no-audit",
          "--no-fund",
        ]);
        await run(npm.command, npm.args, { ...options, timeout: 180000 });
        await rename(stage, destination);
      } catch {
        throw new HubError(
          "bootstrap-failed",
          "Could not install the pinned dependency. Check network, Git access and npm, then retry.",
          { dependency: name },
        );
      }
    }
    installed[name] = {
      path: await dependencyPath(home, name),
      commit: source.commit,
      url: source.url,
    };
  }
  await atomicJson(join(home, "bootstrap.json"), { version: 1, installed });
  return { installed };
}
