# openclaw-repo-guard

Repo Guard is an OpenClaw plugin that blocks unsafe git push operations before `exec` tool calls are allowed to run.

## What it enforces

Repo Guard intercepts `exec` calls that contain `git push` and applies preflight checks before the command is allowed to run.

Current protections:
- blocks force pushes
- blocks pushes from branches whose PR has already been merged
- blocks direct pushes to the default branch unless the repo path is explicitly allowlisted
- blocks pushes from branches that are not based on the latest fetched `origin/<default-branch>` tip
- refreshes and caches repo and PR preflight state before allowing a push

Important: direct pushes to a default branch are denied by default. The only exception is an exact path match in `allowDirectPushRepos`.

That last rule is important: if you forgot to fetch/rebase and your branch is based on a stale default branch, Repo Guard should stop the push and tell you to rebase or create a fresh branch first.

## How it works

For push preflight, Repo Guard inspects:
- current branch
- origin remote slug
- default branch from `origin/HEAD`
- PR state for the current branch via `gh pr list`
- merge-base between the current branch and `origin/<default-branch>`
- latest fetched commit for `origin/<default-branch>`

If the merge-base does not equal the latest fetched default-branch tip, the branch is treated as stale and the push is blocked.

## Files

- `index.js` — plugin implementation
- `openclaw.plugin.json` — plugin manifest and config schema
- `package.json` — package metadata
- `README.md` — behavior, installation, and update instructions

## Config

Supported plugin config:

- `logFile` — path to the log file
- `stateDir` — path to cached repo state
- `blockForcePush` — whether force pushes are blocked, default `true`
- `requireUpToDateDefaultBase` — whether pushes from stale branch bases are blocked, default `true`
- `preflightMaxAgeMs` — max age of cached preflight state, default `60000`
- `allowDirectPushRepos` — list of repo paths allowed to push directly to default branch

## Installation

Example local install into an OpenClaw plugins directory:

```bash
cd ~/.openclaw/plugins
git clone https://github.com/Sundin/openclaw-repo-guard.git repo-guard
```

Then configure OpenClaw to load the plugin from that path, typically via your OpenClaw plugin configuration.

At minimum, the plugin directory needs these files present:
- `index.js`
- `openclaw.plugin.json`
- `package.json`

## Updating

To update an existing installation:

```bash
cd ~/.openclaw/plugins/repo-guard
git fetch origin
git checkout master
git pull --ff-only origin master
openclaw plugins reload
# or, if your setup does not hot-reload plugins:
openclaw gateway restart
```

After updating, verify the loaded build from the repo-guard log:

```bash
tail -20 ~/.openclaw/logs/repo-guard.log
```

You should see a fresh `[STARTUP]` line for the new build.

Important: bump the runtime `BUILD_SIGNATURE` in `index.js` whenever behavior changes that you need to verify after restart. Updating `package.json` alone is not enough for runtime verification, because the startup log prints `BUILD_SIGNATURE`, not the package version.

## Deterministic verification

For local contributor checks, use the same deterministic suite entrypoint as CI:

```bash
npm run ci
```

That command runs both syntax validation targets:
- `node --check index.js`
- `node --check lib/repo-guard-core.js`

And the deterministic test suite:
- `node --test test/*.test.mjs`

This repo intentionally keeps CI limited to deterministic checks only. It does not require a live OpenClaw gateway, networked integration fixtures, or external services.

## Recommended workflow with Repo Guard enabled

Before pushing a branch:

```bash
git fetch origin
git rebase origin/master
# or create a fresh branch from the updated default branch
```

Before pushing directly to a default branch, make sure the repo path is intentionally allowlisted. If it is not in `allowDirectPushRepos`, Repo Guard should block the push.

If Repo Guard blocks the push because the branch base is stale, that is intentional. The expected fix is to rebase onto the latest fetched default branch or create a new branch from it.

## Logging and state

By default the plugin writes:
- logs under the OpenClaw logs directory
- cached repo preflight state under the OpenClaw state directory

## Notes

This repo was extracted from a local OpenClaw plugin installation so it can be version controlled and improved normally.
