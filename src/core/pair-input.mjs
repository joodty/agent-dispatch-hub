import { access, lstat, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory, HubError, validName } from "./state.mjs";

async function outsideGit(path) {
  let directory = dirname(path);
  while (true) {
    try {
      await access(join(directory, ".git"));
      throw new HubError(
        "pair-input-in-repository",
        "Keep the authenticated launch URL outside every Git work tree. Use target pair --prepare-input.",
      );
    } catch (error) {
      if (error instanceof HubError) throw error;
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
function managed(home, path) {
  const part = relative(join(home, "pair-input"), path);
  return part !== "" && !part.startsWith("..") && !isAbsolute(part);
}
export async function preparePairInput(home, target) {
  validName(target, "target");
  const directory = join(home, "pair-input");
  const path = join(directory, `${target}-${randomUUID()}.launch-url.txt`);
  await outsideGit(path);
  await privateDirectory(directory);
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return {
    target,
    inputFile: path,
    instruction:
      "Write only the launch URL to this protected file, without printing it. Pair using --from-file; the managed input is removed after successful pairing.",
  };
}
export async function readPairInput(home, file) {
  const path = resolve(file);
  await outsideGit(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw new HubError(
      "invalid-pair-input",
      "Expected a small regular protected launch URL file.",
    );
  if (process.platform === "win32") {
    if (!managed(home, path))
      throw new HubError(
        "pair-input-location",
        "On Windows, use the private file returned by target pair --prepare-input.",
      );
    await privateDirectory(join(home, "pair-input"));
  } else if (info.mode & 0o077)
    throw new HubError(
      "pair-input-permissions",
      "Launch URL input requires owner-only file permissions (0600).",
    );
  return {
    path,
    text: await readFile(path, "utf8"),
    managed: managed(home, path),
  };
}
export async function consumePairInput(input) {
  if (input?.managed) await unlink(input.path);
}
