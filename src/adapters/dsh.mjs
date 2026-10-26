import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { dependencyPath } from "../core/dependencies.mjs";
import { readJson, HubError } from "../core/state.mjs";

export async function createDshAdapter(target, { home, clientModule } = {}) {
  const module =
    clientModule ??
    (await import(
      pathToFileURL(
        join(await dependencyPath(home, "bridge"), "scripts/dsh-client.mjs"),
      ).href
    ));
  const env = {};
  const connection = target.connection;
  if (connection.kind === "local") {
    if (typeof connection.connectionFile !== "string")
      throw new HubError(
        "invalid-target",
        "Local DSH needs an explicit companion connection file.",
      );
    env.DSH_BRIDGE_CONNECTION_FILE = connection.connectionFile;
  } else if (connection.kind === "remote") {
    let origin;
    try {
      origin = new URL(connection.baseUrl);
    } catch {
      throw new HubError(
        "invalid-target",
        "Remote DSH requires a valid HTTPS origin.",
      );
    }
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    )
      throw new HubError(
        "invalid-target",
        "Remote DSH requires a clean HTTPS origin.",
      );
    let credential;
    try {
      credential = await readJson(connection.credentialFile);
    } catch {
      throw new HubError(
        "pairing-required",
        "Pair the selected remote target before dispatch.",
      );
    }
    if (credential.version !== 1 || credential.origin !== origin.origin)
      throw new HubError(
        "credential-mismatch",
        "Credential does not belong to the selected DSH origin. Pair this target again.",
      );
    env.DSH_ALLOW_REMOTE = "true";
    env.DSH_BASE_URL = origin.origin;
    if (typeof credential.cookie === "string" && credential.cookie)
      env.DSH_BRIDGE_COOKIE = credential.cookie;
    else if (typeof credential.token === "string" && credential.token)
      env.DSH_BRIDGE_TOKEN = credential.token;
    else
      throw new HubError(
        "pairing-required",
        "Pair the selected remote target before dispatch.",
      );
  } else
    throw new HubError(
      "invalid-target",
      "DSH connection kind must be local or remote.",
    );
  const client = new module.DshClient({
    env,
    configPath: join(home, "targets", target.name, "bridge-settings.json"),
  });
  return {
    status: () => client.describe(),
    dispatch: (args) => client.dispatch(args),
    send: (args) => client.sendMessage(args),
    wait: (args) => client.waitForSession(args),
    messages: (args) => client.getMessages(args),
    cancel: (args) => client.cancelSession(args),
    readArtifact: (args) => client.readArtifact(args),
    close: () => client.close(),
  };
}
