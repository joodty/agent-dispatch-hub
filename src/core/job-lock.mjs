import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HubError } from "./state.mjs";

export async function withJobWriter(home, id, fn) {
  const path = join(home, "jobs", id + ".lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new HubError(
        "job-busy",
        "Another operation is updating this job. Retry after it completes.",
        { jobId: id },
      );
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    return await fn();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
