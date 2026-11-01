# Accessibility

The goal is for the extension to be usable with a keyboard and with assistive
technologies. It has not had a formal accessibility audit, and it has not been tested
with a screen reader, so this page makes no conformance claim.

## What works today

- Controls are native HTML buttons, inputs, checkboxes and radio buttons, and the form
  fields of the filter window have labels.
- The label search takes Up, Down, Enter and Escape.
- `Alt+Shift+L` opens the "Gmail Labels" button.
- The buttons of the label bar have tooltips.
- The interface is available in English and in French.

## Known limitations

- The `×`, `+` and `⟳` buttons of the label bar rely on a `title`, with no dedicated
  accessible name.
- Lists built by the extension have no ARIA roles, and status changes are not announced
  to screen readers.
- Only the label bar adapts to a dark system theme.
- Label colors come from Gmail, so their contrast is not guaranteed.

## Supported environment

Thunderbird 128 or later, on the platforms where Thunderbird runs. The extension relies
on Thunderbird for high contrast and zoom settings.

## Reporting a barrier

[Open an issue](https://github.com/likehopper/thunderbird-gmail-labels/issues/new/choose)
and describe the task you tried, your assistive technology if any, and your Thunderbird
version.
