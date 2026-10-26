import { join, resolve } from "node:path";
import { Hub } from "./hub.mjs";
import { privateDirectory, atomicJson, HubError } from "./state.mjs";

export async function pairTarget(
  home,
  name,
  launchInput,
  { fetchImpl = fetch } = {},
) {
  const target = await new Hub({ home }).target(name);
  if (target.connection.kind !== "remote")
    throw new HubError(
      "invalid-target",
      "Pairing is only for explicitly configured remote targets.",
    );
  const file = join(home, "credentials", name + ".json");
  if (
    typeof target.connection.credentialFile !== "string" ||
    resolve(target.connection.credentialFile) !== resolve(file)
  )
    throw new HubError(
      "invalid-target",
      "Credential file must be the hub-managed file for this target. Use setup remote to generate it.",
    );
  let url;
  try {
    url = new URL(launchInput.trim());
  } catch {
    throw new HubError(
      "invalid-pairing-input",
      "Expected a DSH authenticated launch URL from the selected remote host.",
    );
  }
  const origin = new URL(target.connection.baseUrl);
  if (
    url.origin !== origin.origin ||
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("token").length !== 1
  )
    throw new HubError(
      "pairing-origin-mismatch",
      "Launch URL must belong to the exact configured HTTPS target and root path.",
    );
  const token = url.searchParams.get("token");
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token))
    throw new HubError(
      "invalid-pairing-input",
      "DSH launch URL is missing a valid launch token.",
    );
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HubError(
      "pairing-failed",
      "Cannot reach the selected remote DSH. Check TLS and connectivity.",
    );
  }
  if (response.status !== 302)
    throw new HubError(
      "pairing-failed",
      "DSH did not accept its launch token. Obtain a fresh URL from that DSH instance.",
    );
  const location = new URL(response.headers.get("location") ?? "", origin);
  if (location.origin !== origin.origin)
    throw new HubError(
      "pairing-failed",
      "DSH returned a redirect outside the configured origin.",
    );
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!cookie || /[\r\n]/.test(cookie))
    throw new HubError(
      "pairing-failed",
      "DSH returned no valid browser session cookie.",
    );
  await privateDirectory(join(home, "credentials"));
  await atomicJson(file, {
    version: 1,
    origin: origin.origin,
    cookie,
    pairedAt: new Date().toISOString(),
  });
  return { target: name, paired: true, credentialFile: file };
}
