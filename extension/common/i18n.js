/**
 * Translations: _locales/en by default, _locales/fr when Thunderbird runs in French.
 * Code calls translate("key", ...values); static HTML uses the data-i18n attributes.
 */
function translate(key, ...substitutions) {
  return browser.i18n.getMessage(key, substitutions.map(String)) || key;
}

function localizePage() {
  document.documentElement.lang = browser.i18n.getUILanguage();
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = translate(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = translate(node.dataset.i18nPlaceholder);
  }
}
