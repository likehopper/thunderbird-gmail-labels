# Gmail Labels for Thunderbird

A Thunderbird extension that shows the **real** Gmail labels of a message, lets you
manage them, and helps you create Gmail filters. It talks to the Gmail API directly,
instead of guessing labels from IMAP folders.

The interface is in English, or in French when Thunderbird runs in French.

## Features

- **Label bar** at the top of each message, with the Gmail colors:
  - `×` removes a label (on *Inbox*, it archives the message);
  - `+` searches for a label, or creates it (Up/Down/Enter/Escape); the 10 most
    recently added labels come first;
  - `⟳` reloads the labels from Gmail, ignoring the cache.
- **"Gmail Labels" button**, in the message header and in the main toolbar
  (shortcut: `Alt+Shift+L`): the message's labels, then the recent ones, then all
  the others, with search and creation.
- **Filter suggestions**: see [below](#filter-suggestions).
- **Offline mode**: last known labels, and changes are replayed when you are back
  online. See [below](#offline-mode).
- **Setup assistant**: direct links to each Google Cloud page, values to copy, and a
  check of each account.

## Requirements

- Thunderbird 128 or later
- A Gmail or Google Workspace account connected through IMAP
- A Google Cloud OAuth client of your own (free, see [Setup](#setup)). On a Google
  Workspace account, your administrator may have to allow it.

## Installation

Download the `.xpi` file of the
[latest release](https://github.com/likehopper/thunderbird-gmail-labels/releases/latest),
then in Thunderbird: *Add-ons and Themes* → gear icon → *Install Add-on From File…*

From version 1.0.1, updates are managed by
[addons.thunderbird.net](https://addons.thunderbird.net/). Version 1.0.0 still reads
[`updates.json`](updates.json), which moves it to 1.0.1.

### Release channels

- **Stable**: [addons.thunderbird.net](https://addons.thunderbird.net/), or the
  [latest release](https://github.com/likehopper/thunderbird-gmail-labels/releases/latest).
- **Beta**: install the `.xpi` of the latest
  [pre-release](https://github.com/likehopper/thunderbird-gmail-labels/releases) over
  your version. Settings and authorizations are kept, and later betas arrive by
  themselves. When the next stable version comes out, Thunderbird moves you to it.

To leave the beta earlier, install the stable `.xpi` over it, without uninstalling:
uninstalling can erase your settings.

## Setup

The setup assistant opens on first install. To open it later: *Add-ons and Themes* →
*Gmail Labels* → *Preferences*. It walks you through these steps, once:

1. **Create your Google access**: a Google Cloud project with the Gmail API enabled,
   a consent screen, and an OAuth client of type *Web application* using the
   redirect URI shown by the assistant.
2. **Enter the client ID and secret.**
3. **Authorize your accounts.** On the "Google hasn't verified this app" screen,
   click *Continue*: it is your own app. A check then runs automatically.
4. **Publish the app** (*Audience* → *Publish app*), then revoke and authorize again.
   While the app is *In testing*, Google asks for a new authorization every 7 days.
   Authorizations given before publishing keep that limit: the status in step 3
   shows either the expiry date, or "no time limit".

## Filter suggestions

Moving a message to a label's folder, or adding a personal label from the bar or the
button, opens a "Create a Gmail filter?" window. The same window opens from
*Create a Gmail filter…* in the context menu of a message (message list or message
itself), with the label of its folder preselected:

- **Criterion**: addresses or domains of the message, or free keywords separated by
  `|`. Several checked values are combined with OR.
- **Search in**: From, To / Cc, Reply-to and/or Subject. Several fields are combined
  with OR, written `{a b}` by Gmail's search syntax. Reply-to uses the `replyto:`
  operator, which Google does not document but Gmail recognizes.
- **The resulting Gmail search stays editable**, and the number of matching messages
  is shown for the whole mailbox and for the inbox.
- **Actions**: the label, plus optional ones (category, skip the inbox, mark as read,
  star, important, never spam, delete).
- **Checks as you type**: an identical filter blocks the creation; a filter that
  already covers this search, or shares a term with it, is shown, and can be opened or
  extended (*Add to this filter*). A preview shows the last matching messages and the
  labels they already have. *Compare with all filters* counts the messages in common
  with each filter; these figures come from Gmail searches, which can differ slightly
  from what a filter really does.
- **Existing messages**: a Gmail filter only applies to new incoming messages. You
  can also apply it once to the existing messages of the inbox, or to the whole
  mailbox (5,000 messages at most).

No suggestion is made for the trash, spam, `[Gmail]/…` folders, moves between
accounts, or when an existing filter already adds this label for this sender or
domain. *Not now* lasts until Thunderbird restarts; *Don't suggest for this label
again* can be reset in the setup page.

## Managing filters

*Manage Gmail filters* (in the popup, the setup page and the context menu of a
message) lists the filters of an
account, with their label, criteria, actions and number of messages. You can search,
sort and filter them by label, action, field or state (duplicate, deleted label,
forwarding), and export them as JSON.

- **Edit** reuses the filter window. Gmail cannot update a filter: the extension
  creates the new one, then deletes the old one, so the filter gets a new id. Criteria
  and actions the window does not show are kept.
- *Edit a Gmail filter* in the context menu of a message lists the filters matching its
  addresses or subject (exact for OR searches, approximate otherwise) and opens one in
  the same window.
- **Delete** asks to click twice, and can be undone from the page while it stays open.
  Deleting a selection first downloads a JSON copy of it. The edition window can also
  delete its filter (twice too, without undo).
- Changing or deleting a filter does not change messages already filed.
- **Optimize** merges the filters doing exactly the same thing (label, category,
  options, forwarding) with a plain OR search into as few filters as possible, without
  the terms already covered by a domain of the same field: they still match the same
  messages. Each group can be unchecked, and a JSON copy of all the filters is
  downloaded first. The longest search Gmail accepts is measured once, with test
  filters matching no message that are deleted at once; merged searches keep 10% of
  it free to be extended later. The same panel lists the *concurrent filters*: they
  share a term but do different things, so a message gets both.
- Offline, the last known list is shown read-only.

## Offline mode

- Labels of messages already viewed online stay available (up to 10,000 messages,
  for 180 days).
- Changes are queued, shown with a dashed outline, then replayed in order when the
  network is back. If the same message changed elsewhere in the meantime, the last
  change applied wins.
- A message never viewed online falls back on the locally synced IMAP folders,
  read-only.

To test it, really cut the network: Thunderbird's "Work Offline" mode does not
prevent the extension from reaching Google.

## Privacy and permissions

The extension only talks to Google, with your own OAuth client: there is no other
server, and no analytics.

| Permission | Why |
| --- | --- |
| `gmail.modify` (Google) | Read and change labels, search messages |
| `gmail.settings.basic` (Google) | Read, create and delete filters |
| `accountsRead`, `messagesRead` | Find the displayed message and its account |
| `messagesModify` | Add the label bar to the message display |
| `messagesMove` | Remove the label of the open folder at once |
| `menus` | Filter entries in the context menu of a message |
| `downloads` | Save the JSON copies of the filters (export, before a bulk deletion or an optimization) |
| `identity`, `storage` | Sign in to Google, keep settings and offline data |

The refresh token and client secret are stored **unencrypted** in your Thunderbird
profile (`storage.local`).

## Troubleshooting

Start with the **Check** button in step 3 of the setup page: it tests each account
and says what to do. The usual causes:

| Symptom | Cause and fix |
| --- | --- |
| "Authorization expired" after a few days | The Google app is still *In testing*: publish it, then revoke and authorize again |
| "Missing permission" | A scope is missing: add it in *Data access*, then revoke and authorize again |
| "Access blocked" by your administrator | Google Workspace policy: your administrator must allow your client ID |
| `redirect_uri_mismatch` | The client's redirect URI must be exactly the one shown in step 1, with the trailing `/` |
| "The Gmail API is not enabled" | Enable it in the Google Cloud project |
| The bar does not appear | Check the option in step 5, and that the account is authorized |
| A removed label's message stays in the folder | Subscribe to `[Gmail]/All Mail` in Thunderbird |

Still stuck? Open `about:debugging` → *This Thunderbird* → *Inspect* on the extension
for the console messages, then
[open an issue](https://github.com/likehopper/thunderbird-gmail-labels/issues).

## Limitations

- Labels are managed **per message**, not per conversation.
- Labels cannot be shown in the message header or in a message list column: only
  privileged "Experiment" add-ons can do that, and this extension deliberately uses
  standard permissions only.
- Thunderbird sees changes made through the API at its next IMAP sync.

## Development

```sh
./build.sh          # creates dist/thunderbird-gmail-labels-<version>.xpi
./build.sh --beta   # same, with the update_url of the beta channel
./release.sh        # publishes the manifest's version (from main or beta, with a clean tree)
```

Work happens on the `beta` branch, with versions like `1.2.0b1`:

1. To publish a beta: raise `version`, commit, run `release.sh` from `beta`. It creates
   a pre-release and updates `updates-beta.json`, an asset of the `beta-feed` release.
2. To go stable: open a pull request from `beta` to `main`, then on `main` set the
   stable version (`1.2.0`), commit, run `release.sh`, and upload the same `.xpi` to
   addons.thunderbird.net. `release.sh` refuses a beta version on `main`.
3. Merge `main` back into `beta`, and raise the version to continue.

`release.sh` needs the [GitHub CLI](https://cli.github.com/).
`extension/manifest.json` must not contain `update_url`: addons.thunderbird.net rejects
it, so only `build.sh --beta` adds it, to the built `.xpi`.

Never change the extension id: updates and the OAuth redirect URI depend on it.

Translations are in `extension/_locales/`. Code uses `translate("key")`, and static
HTML uses `data-i18n` attributes.

## License

[MIT](LICENSE). Not affiliated with Google or Mozilla.
