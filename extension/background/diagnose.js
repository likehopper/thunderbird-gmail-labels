/**
 * Account diagnostic for the setup page: each check returns { name, ok, detail }
 * (ok is true, false, or null for a mere warning), with what to do on failure.
 * Stops at the first blocking problem.
 */
const TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";

async function diagnoseAccount(email) {
  const checks = [];
  const addCheck = (nameKey, ok, detail = "") => {
    checks.push({ name: translate(nameKey), ok, detail });
    return ok;
  };

  const { clientId, clientSecret } = await loadStore("settings", {});
  const clientConfigured = Boolean(clientId && clientSecret);
  if (!addCheck("chkClient", clientConfigured, clientConfigured ? "" : translate("fixClient"))) return checks;
  const tokens = await loadStore("tokens", {});
  const authorized = Boolean(tokens[email]);
  if (!addCheck("chkAuthorized", authorized, authorized ? "" : translate("fixAuthorize"))) return checks;

  let accessToken;
  accessTokens.delete(email);
  try {
    accessToken = await getAccessToken(email);
    addCheck("chkNetwork", true);
    addCheck("chkToken", true);
  } catch (error) {
    if (error instanceof OfflineError) addCheck("chkNetwork", false, translate("fixNetwork"));
    else if (error instanceof AuthError) addCheck("chkToken", false, translate("fixTokenExpired"));
    else addCheck("chkToken", false, /client/i.test(error.message) ? translate("fixTokenClient") : error.message);
    return checks;
  }

  try {
    const url = `${TOKEN_INFO_URL}?access_token=${encodeURIComponent(accessToken)}`;
    const tokenInfo = await (await fetch(url)).json();
    if (!tokenInfo.scope) throw new Error(tokenInfo.error_description ?? "tokeninfo");
    const grantedScopes = tokenInfo.scope.split(" ");
    const missingScopes = OAUTH_SCOPES.filter(scope => !grantedScopes.includes(scope));
    addCheck("chkScopes", !missingScopes.length,
      missingScopes.length ? translate("fixScopes", missingScopes.join(", ")) : "");
  } catch (error) {
    addCheck("chkScopes", null, error.message);
  }

  try {
    await gmailRequest(email, "/profile", {}, false);
    addCheck("chkApi", true);
  } catch (error) {
    const apiDisabled = /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(error.message);
    addCheck("chkApi", false, apiDisabled ? translate("fixApiDisabled") : error.message);
    return checks;
  }

  try {
    const labelsById = await listLabels(email, true);
    const userLabelCount = [...labelsById.values()].filter(label => label.type === "user").length;
    addCheck("chkLabels", true, translate("detailLabels", userLabelCount));
  } catch (error) {
    addCheck("chkLabels", false, error.message);
  }
  try {
    addCheck("chkFilters", true, translate("detailFilters", (await listFilters(email)).length));
  } catch (error) {
    addCheck("chkFilters", false, error.message);
  }

  const accounts = await browser.accounts.list(false);
  const account = accounts.find(candidate => candidate.identities?.[0]?.email?.toLowerCase() === email);
  const allMailFolder = account ? await findAllMailFolder(account.id).catch(() => null) : null;
  addCheck("chkAllMail", allMailFolder ? true : null, allMailFolder ? "" : translate("fixAllMail"));
  return checks;
}

browser.runtime.onMessage.addListener(request => {
  if (request?.command === "scopes") return Promise.resolve(OAUTH_SCOPES);
  if (request?.command !== "diagnose") return undefined;
  return diagnoseAccount(request.email)
    .catch(error => [{ name: request.email, ok: false, detail: error.message }]);
});

// First install: open the setup assistant right away
browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") browser.runtime.openOptionsPage();
});
