# Security policy

## Reporting a vulnerability

Email **dmitry.zaicew@gmail.com** with subject prefix `[security]`.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected version(s).

Do **not** file public GitHub issues for security bugs.

## Response

- Acknowledgement within **7 days** of receipt.
- Fix or coordinated disclosure within **90 days**, whichever comes first.

## Supported versions

Only the latest released version receives security fixes. Releases are
cut from `main` and shipped via the Homebrew tap — see
[`RELEASING.md`](RELEASING.md).

## Out of scope

- Bugs without security impact — please file a regular [GitHub issue](https://github.com/dmitry-zaitsev/istoria/issues).
- Vulnerabilities in third-party dependencies — report upstream first; we'll
  bump the dependency once a fixed version exists.
