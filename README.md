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

Thunderbird then keeps the extension up to date on its own, through
[`updates.json`](updates.json).

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

## Filter suggestions

Moving a message to a label's folder, or adding a personal label from the bar or the
button, opens a "Create a Gmail filter?" window:

- **Criterion**: an address or a domain of the message, or a free keyword.
- **Search in**: From, To / Cc, Reply-to and/or Subject. Several fields are combined
  with OR, written `{a b}` by Gmail's search syntax. Reply-to uses the `replyto:`
  operator, which Google does not document but Gmail recognizes.
- **The resulting Gmail search stays editable**, and the number of matching messages
  is shown for the whole mailbox and for the inbox.
- **Action**: add the label, and optionally skip the inbox.
- **Existing messages**: a Gmail filter only applies to new incoming messages. You
  can also apply it once to the existing messages of the inbox, or to the whole
  mailbox (5,000 messages at most).

No suggestion is made for the trash, spam, `[Gmail]/…` folders, moves between
accounts, or when an existing filter already adds this label for this sender or
domain. *Not now* lasts until Thunderbird restarts; *Don't suggest for this label
again* can be reset in the setup page.

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
| `gmail.settings.basic` (Google) | Read and create filters |
| `accountsRead`, `messagesRead` | Find the displayed message and its account |
| `messagesModify` | Add the label bar to the message display |
| `messagesMove` | Remove the label of the open folder at once |
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
./build.sh     # creates dist/thunderbird-gmail-labels-<version>.xpi
./release.sh   # publishes the manifest's version (from main, with a clean tree)
```

To publish a version: raise `version` in `extension/manifest.json`, commit, then run
`release.sh`. It needs the [GitHub CLI](https://cli.github.com/).

Never change the extension id: updates and the OAuth redirect URI depend on it.

Translations are in `extension/_locales/`. Code uses `translate("key")`, and static
HTML uses `data-i18n` attributes.

## License

[MIT](LICENSE). Not affiliated with Google or Mozilla.
