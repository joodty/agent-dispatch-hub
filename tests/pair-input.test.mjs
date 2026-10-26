import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  preparePairInput,
  readPairInput,
  consumePairInput,
} from "../src/core/pair-input.mjs";
import { stateHome } from "../src/core/state.mjs";

test("managed pairing input is private, readable without echo, and consumed after use", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "adh-input-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prepared = await preparePairInput(home, "home");
  const dummy = "https://dsh.example.com/?token=" + "a".repeat(43);
  await writeFile(prepared.inputFile, dummy);
  const input = await readPairInput(home, prepared.inputFile);
  assert.equal(input.text, dummy);
  assert.equal(input.managed, true);
  assert.ok(!JSON.stringify(prepared).includes(dummy));
  if (process.platform !== "win32")
    assert.equal((await stat(prepared.inputFile)).mode & 0o077, 0);
  await consumePairInput(input);
  await assert.rejects(readFile(prepared.inputFile), { code: "ENOENT" });
});
test("pairing input in a Git work tree is refused before consumption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adh-input-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const path = join(root, "launch-url.txt");
  await writeFile(path, "dummy-fixture");
  await assert.rejects(
    readPairInput(join(tmpdir(), "unused-adh-state"), path),
    { code: "pair-input-in-repository" },
  );
  assert.equal(await readFile(path, "utf8"), "dummy-fixture");
});
test("state cannot be an entire user home or this source checkout", () => {
  assert.throws(() => stateHome(homedir()), { code: "invalid-home" });
  assert.throws(() => stateHome(process.cwd()), { code: "invalid-home" });
});
