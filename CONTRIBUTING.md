# Contributing

Bug reports, translations and code are all welcome. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a problem

- First use the **Check** button in step 3 of the setup page, and read
  [Troubleshooting](README.md#troubleshooting).
- Then [open an issue](https://github.com/likehopper/thunderbird-gmail-labels/issues/new/choose).
- For a security problem, follow the [security policy](SECURITY.md) instead.

Never post a client secret, a token, or private message content. Check console output
before pasting it.

## Working on the code

There is no dependency to install and no automated test. To try a change:

1. Run `./build.sh`, which creates the `.xpi` in `dist/`.
2. In Thunderbird, open `about:debugging` → *This Thunderbird* → *Load Temporary
   Add-on*, and pick `extension/manifest.json` or the `.xpi`.
3. Test with a real Gmail or Google Workspace account, using your own OAuth client
   (see [Setup](README.md#setup)).

Keep these rules:

- **Standard permissions only.** No Experiment APIs (`experiment_apis`).
- **Never change the extension id:** updates and the OAuth redirect URI depend on it.
- **No `update_url` in `extension/manifest.json`:** addons.thunderbird.net rejects it.
- **Google only.** The extension must not contact any other server, and must not
  collect analytics.
- **Explain new permissions.** Any new permission or Google scope also needs a line in
  [Privacy and permissions](README.md#privacy-and-permissions).

## Translations

Translations are in `extension/_locales/`. Code uses `translate("key")`, and static
HTML uses `data-i18n` attributes. Any new text goes in both `en` and `fr`. A new
language only needs a new folder with its own `messages.json`.

## Pull requests

- Base your pull request on the `beta` branch when it exists, otherwise on `main`.
- Keep each pull request to one subject, and describe what you tested and how.
- Write code, comments and commit messages in English.
- Update the README when behavior changes.

Contributions are published under the [MIT license](LICENSE).
