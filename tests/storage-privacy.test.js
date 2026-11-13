const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionPath = path.join(__dirname, "..", "extension");
const readExtension = file => fs.readFileSync(path.join(extensionPath, file), "utf8");
const listFiles = (directory, prefix = "") => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const relative = path.join(prefix, entry.name);
  return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relative) : [relative];
});

function storageContext(initial) {
  const data = structuredClone(initial);
  const storage = {
    async get(key) {
      if (key === null) return structuredClone(data);
      if (typeof key === "string") return key in data ? { [key]: structuredClone(data[key]) } : {};
      return {};
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  const context = vm.createContext({ browser: { storage: { local: storage } }, structuredClone, URLSearchParams });
  for (const file of ["background/gmail.js", "background/offline.js"]) {
    vm.runInContext(readExtension(file), context, { filename: file });
  }
  return { context, data };
}

test("forgetting an account removes only its local data and queued changes", async () => {
  const email = "one@example.com";
  const otherEmail = "two@example.com";
  const { context, data } = storageContext({
    [`labels:${email}`]: [{ id: "Label_1", name: "Private" }],
    [`filters:${email}`]: [{ id: "filter-1" }],
    [`recent:${email}`]: ["Label_1"],
    [`changeFailure:${email}`]: { status: 400 },
    [`msg:${email}|message@example.com`]: { gmailId: "gmail-1" },
    [`labels:${otherEmail}`]: [{ id: "Label_2" }],
    [`msg:${otherEmail}|other@example.com`]: { gmailId: "gmail-2" },
    queue: [{ email }, { email: otherEmail }],
    settings: { showBar: true, ignoredFolders: ["account-1|/Private", "account-2|/Other"] },
  });

  await vm.runInContext("purgeAccountData", context)(email, ["account-1"]);

  assert.deepEqual(Object.keys(data).sort(), [
    `labels:${otherEmail}`,
    `msg:${otherEmail}|other@example.com`,
    "queue",
    "settings",
  ].sort());
  assert.deepEqual(data.queue, [{ email: otherEmail }]);
  assert.deepEqual(data.settings, { showBar: true, ignoredFolders: ["account-2|/Other"] });
});

test("the shared OAuth client is removed only after the last authorization", async () => {
  const secrets = { clientId: "client-id", clientSecret: "client-secret", showBar: true };
  const withToken = storageContext({ settings: secrets, tokens: { "one@example.com": { refreshToken: "token" } } });
  assert.equal(await vm.runInContext("purgeUnusedOAuthClient", withToken.context)(), false);
  assert.deepEqual(withToken.data.settings, secrets);

  const withoutToken = storageContext({ settings: secrets, tokens: {} });
  assert.equal(await vm.runInContext("purgeUnusedOAuthClient", withoutToken.context)(), true);
  assert.deepEqual(withoutToken.data.settings, { showBar: true });
});

test("queued failure details never retain server text or account data", () => {
  const { context } = storageContext({});
  const sanitized = vm.runInContext("sanitizedChangeError", context)({
    name: "address@example.com",
    message: "Label Customer and message@example.com failed",
    status: 400,
  });
  assert.deepEqual(structuredClone(sanitized), { failedAt: sanitized.failedAt, status: 400 });
  assert.equal(JSON.stringify(sanitized).includes("example.com"), false);
  assert.equal(JSON.stringify(sanitized).includes("Customer"), false);
});

test("only network, authorization, throttling and server failures are retried", () => {
  const { context } = storageContext({});
  assert.equal(vm.runInContext("isRetryableChangeError({ status: 400 })", context), false);
  assert.equal(vm.runInContext("isRetryableChangeError({ status: 429 })", context), true);
  assert.equal(vm.runInContext("isRetryableChangeError({ status: 503 })", context), true);
  assert.equal(vm.runInContext("isRetryableChangeError(new OfflineError('private text'))", context), true);
  assert.equal(vm.runInContext("isRetryableChangeError(new AuthError('private text'))", context), true);
});

test("concurrent offline changes are serialized without loss", async () => {
  const { context, data } = storageContext({ queue: [] });
  const enqueue = vm.runInContext("enqueueChange", context);
  await Promise.all([
    enqueue({ email: "one@example.com", addLabelIds: ["Label_1"], removeLabelIds: [] }),
    enqueue({ email: "one@example.com", addLabelIds: ["Label_2"], removeLabelIds: [] }),
    enqueue({ email: "two@example.com", addLabelIds: [], removeLabelIds: ["INBOX"] }),
  ]);
  assert.equal(data.queue.length, 3);
  assert.deepEqual(data.queue.map(change => change.email), ["one@example.com", "one@example.com", "two@example.com"]);
});

test("concurrent settings updates do not restore stale values", async () => {
  const { context, data } = storageContext({
    settings: { clientId: "client-id", clientSecret: "client-secret", showBar: true },
  });
  const update = vm.runInContext("updateSettings", context);
  await Promise.all([
    update(settings => {
      const { clientId, clientSecret, ...preferences } = settings;
      return preferences;
    }),
    update({ hideCategories: false }),
  ]);
  assert.deepEqual(data.settings, { showBar: true, hideCategories: false });
});

test("filter suggestions remain off until explicitly enabled", () => {
  const context = vm.createContext({});
  vm.runInContext(readExtension("common/settings.js"), context);
  const enabled = vm.runInContext("settingEnabled", context);
  assert.equal(enabled({}, "proposeFilters", false), false);
  assert.equal(enabled({ proposeFilters: true }, "proposeFilters", false), true);
  assert.equal(enabled({ proposeFilters: false }, "proposeFilters", false), false);
});

test("the packaged source has the expected privacy surface", () => {
  const manifest = JSON.parse(readExtension("manifest.json"));
  assert.deepEqual(manifest.permissions, [
    "accountsRead", "messagesRead", "messagesModify", "messagesMove", "menus", "downloads", "identity", "storage",
    "https://gmail.googleapis.com/*", "https://oauth2.googleapis.com/*",
  ]);
  for (const script of manifest.background.scripts) {
    assert.equal(fs.existsSync(path.join(extensionPath, script)), true, `missing packaged script: ${script}`);
  }

  const sourceFiles = listFiles(extensionPath).filter(file => /\.(?:html|js|json|svg)$/.test(file));
  const source = sourceFiles.map(file => readExtension(file)).join("\n");
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /GOCSPX-[A-Za-z0-9_-]{10,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
  ];
  for (const pattern of secretPatterns) assert.doesNotMatch(source, pattern);
  assert.doesNotMatch(source, /\b(?:vignolle|smile|intranet)\b/i);

  const urls = [...source.matchAll(/https?:\/\/[^"'<> )]+/g)].map(match => new URL(match[0]));
  const allowedHosts = new Set([
    "accounts.google.com", "console.cloud.google.com", "github.com", "gmail.googleapis.com",
    "oauth2.googleapis.com", "www.googleapis.com", "www.w3.org",
  ]);
  assert.deepEqual([...new Set(urls.map(url => url.hostname).filter(host => !allowedHosts.has(host)))], []);

  const filterList = readExtension("filter-list/filter-list.js");
  assert.doesNotMatch(filterList, /gmail-filters-\$\{email\}/);
  assert.match(filterList, /addEventListener\("click", \(\) => exportFilters\(filters, true\)\)/);
  assert.doesNotMatch(readExtension("background/background.js"), /console\.[a-z]+\([^\n]*oldestChange/);
});
