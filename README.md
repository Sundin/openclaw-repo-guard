# openclaw-repo-guard

Repo Guard is an OpenClaw plugin that blocks unsafe git push operations before `exec` tool calls are allowed to run.

## What it does

It intercepts `exec` calls and checks git push commands before they execute.

Current protections:
- blocks force pushes
- blocks pushes from branches whose PR has already been merged
- blocks direct pushes to the default branch unless the repo is explicitly allowlisted
- refreshes and caches repo/PR preflight state before allowing a push

## Files

- `index.js` — plugin implementation
- `openclaw.plugin.json` — plugin manifest and config schema
- `package.json` — package metadata

## Config

Supported plugin config:

- `logFile` — path to the log file
- `stateDir` — path to cached repo state
- `blockForcePush` — whether force pushes are blocked, default `true`
- `preflightMaxAgeMs` — max age of cached preflight state, default `60000`
- `allowDirectPushRepos` — list of repo paths allowed to push directly to default branch

## Default behavior

By default the plugin writes logs under the OpenClaw home directory and stores preflight state in the OpenClaw state directory.

## Notes

This repo was extracted from a local OpenClaw plugin installation so it can be version controlled and improved normally.
