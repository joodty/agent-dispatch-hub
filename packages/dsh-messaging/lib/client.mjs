import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
export class MailboxClient {
  constructor({ connectionFile, fetchImpl = fetch }) {
    this.connectionFile = connectionFile;
    this.fetch = fetchImpl;
  }
  async call(payload, signal, projectId) {
    if (!isAbsolute(this.connectionFile ?? ""))
      throw Error(
        "Configure an absolute protected mailbox connectionFile on this DSH machine.",
      );
    const info = await lstat(this.connectionFile);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 8192 ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw Error("Mailbox connection file must be a protected regular file.");
    let c = JSON.parse(await readFile(this.connectionFile, "utf8"));
    if (c.version === 1 && Array.isArray(c.connections)) {
      const choices = c.connections.filter(
        (x) => !projectId || x.projectId === projectId,
      );
      if (choices.length !== 1)
        throw Error(
          "Choose exactly one configured project for this DSH profile.",
        );
      return new MailboxClient({
        connectionFile: choices[0].connectionFile,
        fetchImpl: this.fetch,
      }).call(payload, signal);
    }
    const origin = new URL(c.origin);
    if (
      c.version !== 1 ||
      !/^[a-zA-Z0-9-]{32,160}$/.test(c.token ?? "") ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
      )
    )
      throw Error(
        "Mailbox connection requires a clean HTTPS or loopback origin.",
      );
    const response = await this.fetch(new URL("/team/v1/messages", origin), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify(payload),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (text.length > 65536) throw Error("Mailbox response exceeds its limit.");
    const v = JSON.parse(text);
    if (!response.ok || v.ok !== true) {
      const code = /^[a-z][a-z0-9-]{1,70}$/.test(v.error?.code ?? "")
        ? v.error.code
        : "mailbox-unavailable";
      throw Error(
        `Mailbox rejected request (${code}). Keep the original request ID.`,
      );
    }
    return v.value;
  }
}
