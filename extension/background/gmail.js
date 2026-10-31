/**
 * Gmail API access: OAuth2 (authorization code + PKCE through
 * identity.launchWebAuthFlow, one refresh token per address), labels and filters.
 */
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic", // Gmail filters
];
const LABEL_LIST_CACHE_DURATION = 10 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
const MAX_IDS_PER_BATCH_MODIFY = 1000;
const MAX_RESULTS_PER_SEARCH_PAGE = 500;

class AuthError extends Error {}
class OfflineError extends Error {}

const accessTokens = new Map(); // email -> { token, expiresAt }
const labelListCache = new Map(); // email -> { fetchedAt, labelsById: Map }

async function loadStore(key, fallback) {
  const stored = await browser.storage.local.get(key);
  return stored[key] ?? fallback;
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function cacheAccessToken(email, tokenResponse) {
  const lifetimeSeconds = tokenResponse.expires_in - TOKEN_EXPIRY_MARGIN_SECONDS;
  accessTokens.set(email, {
    token: tokenResponse.access_token,
    expiresAt: Date.now() + lifetimeSeconds * 1000,
  });
}

async function postForm(url, parameters) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
  } catch (error) {
    throw new OfflineError(error.message);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error_description || body.error || `HTTP ${response.status}`;
    throw body.error === "invalid_grant" ? new AuthError(message) : new Error(message);
  }
  return body;
}

async function getAccessToken(email) {
  const cachedToken = accessTokens.get(email);
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const tokens = await loadStore("tokens", {});
  const refreshToken = tokens[email]?.refreshToken;
  if (!refreshToken) throw new AuthError(translate("errNotAuthorized", email));
  const { clientId, clientSecret } = await loadStore("settings", {});
  const tokenResponse = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  cacheAccessToken(email, tokenResponse);
  return tokenResponse.access_token;
}

async function gmailRequest(email, path, { method = "GET", body } = {}, retryIfUnauthorized = true) {
  const token = await getAccessToken(email);
  let response;
  try {
    response = await fetch(GMAIL_API_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new OfflineError(error.message);
  }
  if (response.status === 401 && retryIfUnauthorized) {
    accessTokens.delete(email);
    return gmailRequest(email, path, { method, body }, false);
  }
  if (response.status === 204) return null;
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The account was authorized without one of the required scopes
    if (response.status === 403 && /scope/i.test(responseBody.error?.message ?? "")) {
      throw new AuthError(translate("errMissingScope", email));
    }
    const requestError = new Error(responseBody.error?.message || `Gmail HTTP ${response.status}`);
    requestError.status = response.status;
    throw requestError;
  }
  return responseBody;
}

async function authorize(email) {
  const { clientId, clientSecret } = await loadStore("settings", {});
  if (!clientId || !clientSecret) throw new Error(translate("errNoClient"));

  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64UrlEncode(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = browser.identity.getRedirectURL();

  const authorizationUrl = new URL(AUTHORIZATION_URL);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: email,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  const redirectResult = new URL(
    await browser.identity.launchWebAuthFlow({ url: authorizationUrl.href, interactive: true }));
  if (redirectResult.searchParams.get("state") !== state) throw new Error(translate("errOAuthState"));
  const code = redirectResult.searchParams.get("code");
  if (!code) throw new Error(redirectResult.searchParams.get("error") || translate("errNoCode"));

  const tokenResponse = await postForm(TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!tokenResponse.refresh_token) throw new Error(translate("errNoRefresh"));

  // Make sure the user picked the expected Google account
  cacheAccessToken(email, tokenResponse);
  let profile;
  try {
    profile = await gmailRequest(email, "/profile", {}, false);
  } finally {
    accessTokens.delete(email);
  }
  if (profile.emailAddress.toLowerCase() !== email) {
    throw new Error(translate("errWrongAccount", profile.emailAddress, email));
  }
  cacheAccessToken(email, tokenResponse);

  // Google only sends this lifetime for time-limited tokens (app "In testing"):
  // null means no time limit, while undefined marks an older, unknown authorization
  const refreshTokenLifetime = tokenResponse.refresh_token_expires_in;
  const tokens = await loadStore("tokens", {});
  tokens[email] = {
    refreshToken: tokenResponse.refresh_token,
    refreshTokenExpiresAt: refreshTokenLifetime ? Date.now() + refreshTokenLifetime * 1000 : null,
  };
  await browser.storage.local.set({ tokens });
}

async function revoke(email) {
  const tokens = await loadStore("tokens", {});
  const refreshToken = tokens[email]?.refreshToken;
  if (refreshToken) await postForm(REVOCATION_URL, { token: refreshToken }).catch(() => {});
  delete tokens[email];
  await browser.storage.local.set({ tokens });
  accessTokens.delete(email);
  labelListCache.delete(email);
}

async function listLabels(email, bypassCache = false) {
  const cachedList = labelListCache.get(email);
  if (!bypassCache && cachedList && Date.now() - cachedList.fetchedAt < LABEL_LIST_CACHE_DURATION) {
    return cachedList.labelsById;
  }
  let labels;
  try {
    labels = (await gmailRequest(email, "/labels")).labels ?? [];
  } catch (error) {
    // Offline: use the last known list, without caching it in memory
    const storedLabels = error instanceof OfflineError ? await loadStore(`labels:${email}`, null) : null;
    if (!storedLabels) throw error;
    return new Map(storedLabels.map(label => [label.id, label]));
  }
  const labelsById = new Map(labels.map(label => [label.id, label]));
  labelListCache.set(email, { fetchedAt: Date.now(), labelsById });
  await browser.storage.local.set({ [`labels:${email}`]: labels });
  return labelsById;
}

async function searchMessageId(email, headerMessageId) {
  const query = encodeURIComponent(`rfc822msgid:${headerMessageId}`);
  const results = await gmailRequest(email, `/messages?q=${query}&includeSpamTrash=true&maxResults=1`);
  return results.messages?.[0]?.id ?? null;
}

async function getMessageLabels(email, gmailId) {
  const message = await gmailRequest(email, `/messages/${gmailId}?format=minimal`);
  return message.labelIds ?? [];
}

async function modifyLabels(email, gmailId, addLabelIds, removeLabelIds) {
  const message = await gmailRequest(email, `/messages/${gmailId}/modify`, {
    method: "POST",
    body: { addLabelIds, removeLabelIds },
  });
  return message.labelIds ?? [];
}

async function createLabel(email, name) {
  const label = await gmailRequest(email, "/labels", {
    method: "POST",
    body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  labelListCache.delete(email);
  return label;
}

async function listFilters(email) {
  return (await gmailRequest(email, "/settings/filters")).filter ?? [];
}

async function createFilter(email, criteria, action) {
  return gmailRequest(email, "/settings/filters", { method: "POST", body: { criteria, action } });
}

/** Ids of the messages matching a Gmail search (spam and trash excluded). */
async function searchMessages(email, query, maxResults) {
  const ids = [];
  let pageToken;
  do {
    const parameters = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(MAX_RESULTS_PER_SEARCH_PAGE, maxResults - ids.length)),
    });
    if (pageToken) parameters.set("pageToken", pageToken);
    const page = await gmailRequest(email, `/messages?${parameters}`);
    ids.push(...(page.messages ?? []).map(message => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < maxResults);
  return { ids, hasMore: Boolean(pageToken) };
}

async function batchModifyLabels(email, messageIds, addLabelIds, removeLabelIds) {
  for (let start = 0; start < messageIds.length; start += MAX_IDS_PER_BATCH_MODIFY) {
    await gmailRequest(email, "/messages/batchModify", {
      method: "POST",
      body: { ids: messageIds.slice(start, start + MAX_IDS_PER_BATCH_MODIFY), addLabelIds, removeLabelIds },
    });
  }
}

function clearAuthCache() {
  accessTokens.clear();
  labelListCache.clear();
}
