import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureSnapshot,
  diffSnapshots,
} from "../packages/dsh-companion/lib/file-snapshots.mjs";
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "adh-snapshot-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, roots: [{ id: "source", path: root }] };
}
test("metadata snapshots record added modified deleted files and never retain file contents", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "modified.txt"), "secret-content-one");
  await writeFile(path.join(f.root, "removed.txt"), "gone");
  const before = await captureSnapshot(f);
  await writeFile(path.join(f.root, "modified.txt"), "secret-content-two");
  await rm(path.join(f.root, "removed.txt"));
  await writeFile(path.join(f.root, "added.txt"), "new");
  const after = await captureSnapshot(f);
  assert.deepEqual(
    diffSnapshots(before, after).map((x) => [x.path, x.change]),
    [
      ["added.txt", "added"],
      ["modified.txt", "modified"],
      ["removed.txt", "deleted"],
    ],
  );
  assert.equal(
    JSON.stringify({ before, after }).includes("secret-content"),
    false,
  );
  assert.deepEqual(diffSnapshots(after, after), []);
});
test("credential dependency build and symlink exclusions are reported without following external files", async (t) => {
  const f = await fixture(t),
    outside = await mkdtemp(path.join(tmpdir(), "adh-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const d of ["node_modules", ".git", "dist"]) {
    await mkdir(path.join(f.root, d));
    await writeFile(path.join(f.root, d, "ignored"), "hidden");
  }
  await writeFile(path.join(f.root, ".env"), "password");
  await writeFile(path.join(f.root, "visible.txt"), "visible");
  await writeFile(path.join(outside, "outside.txt"), "never-read");
  await symlink(
    outside,
    path.join(f.root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const s = await captureSnapshot(f);
  assert.deepEqual(
    s.files.map((x) => x.path),
    ["visible.txt"],
  );
  assert.equal(s.excluded.count, 5);
  assert.ok(s.excluded.rules.includes("symlink"));
});
test("bounds abort capture explicitly rather than return a partial successful snapshot", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "a"), "12345");
  await writeFile(path.join(f.root, "b"), "12345");
  for (const [limits, code] of [
    [{ maxFiles: 1 }, "limit-files"],
    [{ maxFileBytes: 4 }, "limit-file-bytes"],
    [{ maxTotalBytes: 7 }, "limit-total-bytes"],
  ])
    await assert.rejects(captureSnapshot({ ...f, limits }), { code });
  const signal = AbortSignal.abort();
  await assert.rejects(captureSnapshot({ ...f, signal }));
});
test("deleted root is explicit after a run and invalid baseline roots fail", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "a"), "a");
  const before = await captureSnapshot(f);
  await rm(f.root, { recursive: true });
  await assert.rejects(captureSnapshot(f), { code: "root-missing" });
  const after = await captureSnapshot({ ...f, allowMissingRoots: true });
  assert.equal(after.roots[0].state, "missing");
  assert.equal(diffSnapshots(before, after)[0].change, "deleted");
  const other = structuredClone(after);
  other.roots[0].path = path.join(tmpdir(), "another-root");
  assert.throws(() => diffSnapshots(before, other));
});
