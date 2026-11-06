/**
 * Context menu of a message: create a filter, edit the filters matching the message,
 * open the filter list.
 */
const MENU_CREATE = "filterCreate";
const MENU_EDIT = "filterEdit";
const MENU_LIST = "filterList";
const MENU_EDIT_PREFIX = "filterEdit:"; // + filter id
const MENU_CONTEXTS = ["message_list", "page"];
const MAX_MENU_FILTERS = 15;
const MAX_MENU_TITLE_LENGTH = 90;
const MENU_FILTERS_CACHE_DURATION = 2 * 60 * 1000;

browser.menus.create({ id: MENU_CREATE, title: translate("menuCreateFilter"), contexts: MENU_CONTEXTS, visible: false });
browser.menus.create({ id: MENU_EDIT, title: translate("menuEditFilter"), contexts: MENU_CONTEXTS, visible: false });
browser.menus.create({ id: MENU_LIST, title: translate("manageFilters"), contexts: MENU_CONTEXTS, visible: false });

const menuFiltersCache = new Map(); // email -> { filters, updatedAt }
let menuEditIds = [];
let menuInstance = 0;

/** Filters read at most once every two minutes, so the menu opens quickly. */
async function menuFilters(email) {
  const cached = menuFiltersCache.get(email);
  if (cached && Date.now() - cached.updatedAt < MENU_FILTERS_CACHE_DURATION) return cached.filters;
  const filters = await listFilters(email);
  menuFiltersCache.set(email, { filters, updatedAt: Date.now() });
  return filters;
}

function menuFilterTitle(filter, labelsById) {
  const labelNames = userLabelIds(filter.action).map(id => labelsById.get(id)?.name ?? translate("labelDeleted"));
  const title = translate("labelAndText", labelNames.join(", ") || translate("filterNoLabel"), fullQuery(filter.criteria));
  const shortTitle = title.length > MAX_MENU_TITLE_LENGTH ? `${title.slice(0, MAX_MENU_TITLE_LENGTH - 1)}…` : title;
  return shortTitle.replace(/&/g, "&&"); // "&" marks an access key
}

/** Replaces the entries of the "Edit" submenu with the filters matching the message. */
async function fillEditMenu({ message, email }, instance) {
  const [filters, labelsById, addresses] = await Promise.all([
    menuFilters(email),
    listLabels(email),
    readMessageAddresses(message, "", { withReplyTo: false }),
  ]);
  if (instance !== menuInstance) return false; // the menu was closed meanwhile
  const matching = filters.filter(filter => filterMatchesMessage(filter, { ...addresses, subject: message.subject }));
  await Promise.all(menuEditIds.map(id => browser.menus.remove(id).catch(() => {})));
  menuEditIds = matching.slice(0, MAX_MENU_FILTERS).map(filter => browser.menus.create({
    id: `${MENU_EDIT_PREFIX}${filter.id}`,
    parentId: MENU_EDIT,
    title: menuFilterTitle(filter, labelsById),
    contexts: MENU_CONTEXTS,
  }));
  return matching.length > 0;
}

/** The right-clicked message with its account address, or null if the account is not authorized. */
async function menuMessage(info, tab) {
  const message = info.selectedMessages?.messages?.[0] ??
    (tab ? await getDisplayedMessage(tab.id).catch(() => null) : null);
  if (!message?.folder) return null;
  const email = await authorizedEmail(message.folder.accountId);
  return email ? { message, email } : null;
}

browser.menus.onShown.addListener(async (info, tab) => {
  // menuIds only lists visible entries: test the context, the entries start hidden
  if (!info.contexts.some(context => MENU_CONTEXTS.includes(context))) return;
  const instance = ++menuInstance;
  const target = await menuMessage(info, tab).catch(() => null);
  if (instance !== menuInstance) return;
  await Promise.all([MENU_CREATE, MENU_LIST].map(id => browser.menus.update(id, { visible: Boolean(target) })));
  await browser.menus.update(MENU_EDIT, { visible: false });
  browser.menus.refresh();
  if (!target) return;
  // The filters can take a moment to read: the submenu appears once they are known
  const hasFilters = await fillEditMenu(target, instance).catch(error => {
    console.warn("Gmail Labels: filters of the message unreadable", error);
    return false;
  });
  if (instance !== menuInstance || !hasFilters) return;
  await browser.menus.update(MENU_EDIT, { visible: true });
  browser.menus.refresh();
});

browser.menus.onHidden.addListener(() => menuInstance++);

browser.menus.onClicked.addListener(async (info, tab) => {
  const menuId = String(info.menuItemId);
  if (menuId !== MENU_CREATE && menuId !== MENU_LIST && !menuId.startsWith(MENU_EDIT_PREFIX)) return;
  try {
    const target = await menuMessage(info, tab);
    if (!target) return;
    if (menuId === MENU_LIST) await openFilterList(target.email);
    else if (menuId === MENU_CREATE) await openFilterFormForMessage(target.message, target.email);
    else await openFilterForm(target.email, menuId.slice(MENU_EDIT_PREFIX.length));
  } catch (error) {
    console.warn("Gmail Labels: context menu failed", error);
  }
});
