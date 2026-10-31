/**
 * Step-by-step setup page: creating the Google OAuth client (direct links, values to
 * copy), entering the client, authorizing and diagnosing accounts, settings.
 */
const element = id => document.getElementById(id);
const send = request => browser.runtime.sendMessage(request);
const COPY_FEEDBACK_DELAY = 1500;
const SAVE_FEEDBACK_DELAY = 2000;

async function getSettings() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return settings;
}

async function saveSettings(changes) {
  await browser.storage.local.set({ settings: { ...(await getSettings()), ...changes } });
}

function setStepStatus(stepId, done) {
  const badge = element(stepId).querySelector(".badge");
  badge.textContent = translate(done ? "stepDone" : "stepTodo");
  badge.className = `badge ${done ? "done" : "todo"}`;
}

/** OAuth client input problems (a secret without GOCSPX- is only a warning). */
function validateClient(clientId, clientSecret) {
  const errors = [];
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) errors.push(translate("clientIdInvalid"));
  if (!clientSecret) errors.push(translate("clientSecretMissing"));
  const warning = clientSecret && !clientSecret.startsWith("GOCSPX-") ? translate("clientSecretWarn") : "";
  return { errors, warning };
}

function showClientValidation() {
  const { errors, warning } = validateClient(
    element("clientId").value.trim(),
    element("clientSecret").value.trim());
  element("clientCheck").textContent = [...errors, warning].filter(Boolean).join(" ");
  element("clientCheck").className = errors.length ? "hint error" : "hint";
  return !errors.length;
}

function checkStyle(check) {
  if (check.ok === true) return { className: "ok", symbol: "✓" };
  if (check.ok === false) return { className: "error", symbol: "✗" };
  return { className: "warn", symbol: "!" };
}

function renderChecks(container, checks) {
  const list = document.createElement("ul");
  list.className = "checks";
  for (const check of checks) {
    const { className, symbol } = checkStyle(check);
    const entry = document.createElement("li");
    entry.className = className;
    entry.textContent = `${symbol} ${check.name}${check.detail ? ` : ${check.detail}` : ""}`;
    list.append(entry);
  }
  if (checks.length && checks.every(check => check.ok === true)) {
    const summary = document.createElement("li");
    summary.className = "ok summary";
    summary.textContent = translate("chkAllGood");
    list.append(summary);
  }
  container.replaceChildren(list);
}

async function runDiagnostic(email, container) {
  container.textContent = translate("chkRunning");
  renderChecks(container, await send({ command: "diagnose", email }));
}

function createAuthorizationButton(account) {
  const button = document.createElement("button");
  button.textContent = translate(account.authorized ? "revoke" : "authorize");
  button.addEventListener("click", async () => {
    button.disabled = true;
    element("accountError").textContent = "";
    const result = await send({ command: account.authorized ? "revoke" : "authorize", email: account.email });
    if (!result.ok) element("accountError").textContent = `${account.email} : ${result.error}`;
    // After a successful authorization, check right away that everything works
    renderAccounts(result.ok && !account.authorized ? account.email : null);
  });
  return button;
}

/** Text and style of the status cell: an expiry date means the app is still "In testing". */
function authorizationStatus(account) {
  const expiresAt = account.authorizationExpiresAt;
  if (!account.authorized) return { textContent: translate("notAuthorized"), className: "" };
  if (expiresAt === null) return { textContent: translate("authorizedNoLimit"), className: "ok" };
  if (expiresAt) return { textContent: translate("authorizedUntil", formatDate(expiresAt)), className: "warn" };
  return { textContent: translate("authorized"), className: "ok" };
}

async function renderAccounts(emailToCheck = null) {
  const accounts = await send({ command: "accounts" });
  setStepStatus("step3", accounts.some(account => account.authorized));
  element("testUsers").textContent = accounts.map(account => account.email).filter(Boolean).join("\n");

  const tableBody = element("accounts");
  tableBody.replaceChildren();
  for (const account of accounts) {
    const row = document.createElement("tr");
    for (const text of [account.name, account.email ?? translate("noIdentity")]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    const statusCell = document.createElement("td");
    Object.assign(statusCell, authorizationStatus(account));
    const actionsCell = document.createElement("td");
    actionsCell.className = "actions";
    const diagnosticRow = document.createElement("tr");
    const diagnosticCell = document.createElement("td");
    diagnosticCell.colSpan = 4;
    diagnosticRow.append(diagnosticCell);

    if (account.email) {
      const checkButton = document.createElement("button");
      checkButton.textContent = translate("check");
      checkButton.addEventListener("click", () => runDiagnostic(account.email, diagnosticCell));
      actionsCell.append(createAuthorizationButton(account), " ", checkButton);
    }
    row.append(statusCell, actionsCell);
    tableBody.append(row, diagnosticRow);
    if (account.email === emailToCheck) runDiagnostic(account.email, diagnosticCell);
  }
}

function setUpLinksAndCopyButtons() {
  for (const button of document.querySelectorAll("button.link")) {
    button.addEventListener("click", () => browser.windows.openDefaultBrowser(button.dataset.url));
  }
  for (const button of document.querySelectorAll("button.copy")) {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(element(button.dataset.copy).textContent);
      button.textContent = translate("copied");
      setTimeout(() => (button.textContent = translate("copy")), COPY_FEEDBACK_DELAY);
    });
  }
}

function setUpClientForm(settings) {
  element("clientId").value = settings.clientId ?? "";
  element("clientSecret").value = settings.clientSecret ?? "";
  const clientValid = Boolean(settings.clientId) &&
    !validateClient(settings.clientId, settings.clientSecret ?? "").errors.length;
  setStepStatus("step1", clientValid);
  setStepStatus("step2", clientValid);
  if (settings.clientId) showClientValidation();
  for (const fieldId of ["clientId", "clientSecret"]) {
    element(fieldId).addEventListener("input", showClientValidation);
  }
  element("save").addEventListener("click", async () => {
    if (!showClientValidation()) return;
    await saveSettings({
      clientId: element("clientId").value.trim(),
      clientSecret: element("clientSecret").value.trim(),
    });
    setStepStatus("step1", true);
    setStepStatus("step2", true);
    element("saved").textContent = translate("saved");
    setTimeout(() => (element("saved").textContent = ""), SAVE_FEEDBACK_DELAY);
    element("step3").open = true;
  });
}

function setUpCheckboxSetting(settingName, settings) {
  element(settingName).checked = settings[settingName] !== false;
  element(settingName).addEventListener("change", event => {
    saveSettings({ [settingName]: event.target.checked });
  });
}

function setUpIgnoredLabels(settings) {
  const ignoredCount = settings.ignoredFolders?.length ?? 0;
  if (!ignoredCount) return;
  element("ignoredCount").textContent = translate("ignoredCount", ignoredCount);
  element("resetIgnored").hidden = false;
  element("resetIgnored").addEventListener("click", async () => {
    await saveSettings({ ignoredFolders: [] });
    element("ignoredCount").textContent = "";
    element("resetIgnored").hidden = true;
  });
}

(async () => {
  localizePage();
  const settings = await getSettings();

  element("redirect").textContent = browser.identity.getRedirectURL();
  element("scopes").textContent = (await send({ command: "scopes" })).join("\n");
  setUpLinksAndCopyButtons();
  setUpClientForm(settings);
  for (const settingName of ["showBar", "hideCategories", "proposeFilters"]) {
    setUpCheckboxSetting(settingName, settings);
  }
  setUpIgnoredLabels(settings);

  await renderAccounts();
  // Open the first step left to do
  const firstStepToDo = document.querySelector(".step:has(.badge.todo)");
  (firstStepToDo ?? element("step5")).open = true;
})();
