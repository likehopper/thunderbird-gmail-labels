/**
 * "Create a Gmail filter" window, opened after a message is moved to a label folder
 * or a label is added. The criterion (address, domain or keyword) is searched in the
 * checked fields; the resulting Gmail search stays editable before creation.
 */
const element = id => document.getElementById(id);
const proposalId = new URLSearchParams(location.search).get("id");
const FIELD_NAMES = {
  from: translate("fieldFrom"),
  to: translate("fieldTo"),
  replyTo: translate("fieldReplyTo"),
  subject: translate("fieldSubject"),
};
// Domains shared by everyone: a filter on them would make no sense
const PUBLIC_DOMAIN = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|free|orange|wanadoo|laposte|sfr)\./;
const COUNT_DELAY = 400;
const CLOSE_DELAY = 1200;

const send = request => browser.runtime.sendMessage({ ...request, proposalId });

function setStatus(text, isError = false) {
  element("status").textContent = text ?? "";
  element("status").className = isError ? "error" : "";
}

async function closeWindow() {
  await browser.windows.remove((await browser.windows.getCurrent()).id);
}

function quoteSearchValue(value) {
  const cleanValue = value.replace(/"/g, "");
  return /[\s(){}]/.test(cleanValue) ? `"${cleanValue}"` : cleanValue;
}

/** Several terms between braces mean OR for Gmail. */
function buildQuery() {
  const choice = document.querySelector("input[name=value]:checked");
  const value = choice?.value === "keyword" ? element("keyword").value.trim() : choice?.value;
  const fields = [...document.querySelectorAll("input[name=field]:checked")].map(checkbox => checkbox.value);
  if (!value || !fields.length) return "";
  const searchValue = quoteSearchValue(value);
  const terms = fields.flatMap(field => ({
    from: [`from:${searchValue}`],
    to: [`to:${searchValue}`, `cc:${searchValue}`],
    replyTo: [`replyto:${searchValue}`], // undocumented operator, but recognized by Gmail
    subject: [`subject:${searchValue}`],
  })[field]);
  return terms.length > 1 ? `{${terms.join(" ")}}` : terms[0];
}

/** Addresses then domains, each with the fields where it appears. */
function buildCandidates(addressesByField) {
  const fieldsByValue = new Map();
  const addCandidate = (value, field) => {
    if (!fieldsByValue.has(value)) fieldsByValue.set(value, new Set());
    fieldsByValue.get(value).add(field);
  };
  for (const [field, addresses] of Object.entries(addressesByField)) {
    addresses.forEach(address => addCandidate(address, field));
  }
  for (const [field, addresses] of Object.entries(addressesByField)) {
    for (const address of addresses) {
      const domain = address.slice(address.indexOf("@") + 1);
      if (!PUBLIC_DOMAIN.test(domain)) addCandidate(domain, field);
    }
  }
  return [...fieldsByValue].map(([value, fields]) => ({
    value,
    fields: [...fields],
    isDomain: !value.includes("@"),
  }));
}

function checkFields(fields) {
  for (const checkbox of document.querySelectorAll("input[name=field]")) {
    checkbox.checked = fields.includes(checkbox.value);
  }
}

let countTimer = null;
let latestCountId = 0;

function refreshQuery() {
  element("query").value = buildQuery();
  scheduleCount();
}

const countWithMore = (count, hasMore) => `${count}${hasMore ? "+" : ""}`;

function scheduleCount() {
  clearTimeout(countTimer);
  element("count").textContent = "";
  countTimer = setTimeout(async () => {
    const query = element("query").value.trim();
    if (!query) return;
    const countId = ++latestCountId;
    element("count").textContent = translate("filterSearching");
    const result = await send({ command: "filterCount", query });
    if (countId !== latestCountId) return; // a newer search has started
    element("count").className = result.error ? "hint error" : "hint";
    element("count").textContent = result.error
      ? result.error
      : result.mailboxCount === 0
        ? translate("filterNoMatch")
        : translate("filterMatches",
          countWithMore(result.mailboxCount, result.hasMoreInMailbox),
          countWithMore(result.inboxCount, result.hasMoreInInbox));
  }, COUNT_DELAY);
}

function renderCandidates(candidates) {
  const container = element("values");
  for (const candidate of candidates) {
    const row = document.createElement("label");
    row.className = "option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "value";
    radio.value = candidate.value;
    radio.addEventListener("change", () => {
      checkFields(candidate.fields);
      refreshQuery();
    });
    row.append(radio, candidate.isDomain ? translate("filterDomain", candidate.value) : candidate.value);
    for (const field of candidate.fields) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = FIELD_NAMES[field];
      row.append(" ", tag);
    }
    container.append(row);
  }
}

async function runCommand(command, parameters = {}) {
  document.body.classList.add("busy");
  const result = await send({ command, ...parameters });
  document.body.classList.remove("busy");
  if (result?.error) setStatus(result.error, true);
  return result;
}

(async () => {
  localizePage();
  const proposal = await send({ command: "proposal" });
  if (proposal.error) {
    setStatus(proposal.error, true);
    document.querySelectorAll("fieldset, label, .buttons button:not(#dismiss)")
      .forEach(node => (node.hidden = true));
    element("dismiss").textContent = translate("filterClose");
    element("dismiss").addEventListener("click", closeWindow);
    return;
  }

  const otherMessages = proposal.messageCount > 1
    ? translate("filterIntroMore", proposal.messageCount - 1)
    : "";
  element("intro").textContent = translate("filterIntro",
    proposal.subject || translate("noSubject"), otherMessages, proposal.labelName);
  element("archive").checked = proposal.fromInbox;

  const candidates = buildCandidates(proposal.addresses);
  renderCandidates(candidates);
  const firstRadio = document.querySelector("input[name=value]");
  const keywordRadio = document.querySelector("input[value=keyword]");
  if (firstRadio !== keywordRadio) {
    firstRadio.checked = true;
    checkFields(candidates[0].fields);
  } else {
    keywordRadio.checked = true;
    checkFields(["from"]);
  }
  refreshQuery();

  element("keyword").addEventListener("focus", () => {
    keywordRadio.checked = true;
    refreshQuery();
  });
  element("keyword").addEventListener("input", refreshQuery);
  keywordRadio.addEventListener("change", refreshQuery);
  document.querySelectorAll("input[name=field]")
    .forEach(checkbox => checkbox.addEventListener("change", refreshQuery));
  element("query").addEventListener("input", scheduleCount);

  element("create").addEventListener("click", async () => {
    const query = element("query").value.trim();
    if (!query) return setStatus(translate("filterNeedCriterion"), true);
    setStatus(translate("filterCreating"));
    const existingMessages = document.querySelector("input[name=existing]:checked").value;
    const result = await runCommand("filterCreate", {
      query,
      archive: element("archive").checked,
      existingMessages,
    });
    if (result.error) return;
    setStatus(result.appliedCount
      ? translate("filterCreatedApplied", result.appliedCount)
      : translate("filterCreated"));
    setTimeout(closeWindow, CLOSE_DELAY);
  });
  element("dismiss").addEventListener("click", () => send({ command: "filterDismiss" }).then(closeWindow));
  element("ignore").addEventListener("click", async () => {
    if (!(await runCommand("filterIgnoreFolder")).error) closeWindow();
  });
})();
