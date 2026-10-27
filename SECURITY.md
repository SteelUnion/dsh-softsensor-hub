# Security Policy

## Supported versions

Only the latest release receives fixes. Older versions are not maintained.

| Version | Supported |
|---|---|
| latest release | yes |
| older | no |

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub private vulnerability reporting:

    https://github.com/SteelUnion/dsh-softsensor-hub/security/advisories/new

If that form is unavailable, open an issue that says only "I need a private
contact channel", with no details, and wait for a reply.

## What to include

- plugin version
- DSH version (`dsh --version`)
- what the plugin did, and what you expected
- whether the report involves the HTTP ingest endpoint or stored event data

## Scope

This plugin runs inside DeepSeek Harness. Defects in the harness itself belong
to the upstream project. This policy covers only the plugin's own code.

Note: the ingest endpoint accepts events from other processes. Never paste a
real shared token into an issue or a pull request.
