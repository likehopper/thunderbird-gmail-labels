# Security policy

## Supported versions

Fixes go into the latest stable version and the latest beta. Older versions are not
patched: update to receive a fix.

## Reporting a vulnerability

Please do not open a public issue. Use the
[private report form](https://github.com/likehopper/thunderbird-gmail-labels/security/advisories/new)
instead, with:

- the extension and Thunderbird versions;
- the steps to reproduce the problem;
- what an attacker could gain from it.

Do not include real tokens, client secrets or message content.

This is a personal project maintained on a best-effort basis, so there is no
guaranteed response time. Reports are read, and you will be credited in the fix unless
you prefer otherwise.

## Scope

In scope: anything that exposes Gmail data or Google credentials, or lets a web page or
message content act through the extension.

Known and documented, so not a vulnerability: the refresh token and client secret are
stored unencrypted in the Thunderbird profile (`storage.local`). See
[Privacy and permissions](README.md#privacy-and-permissions).

Problems in Thunderbird or in Google's services should be reported to Mozilla or
Google.
