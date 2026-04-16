import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const DEFAULT_STATE_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'state');
const DEFAULT_LOG_FILE = path.join(process.env.HOME || '/tmp', '.openclaw', 'logs', 'repo-guard.log');
const DEFAULT_PREFLIGHT_MAX_AGE_MS = 60 * 1000;
const BUILD_SIGNATURE = 'repo-guard build 0.1.1-preflight-v2 2026-04-13T10:35Z';

function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function extractExecCommand(params) {
  const candidates = [params?.command, params?.cmd, params?.script];
  return candidates.find((value) => typeof value === 'string') || '';
}

function extractRepoPath(command, params) {
  const match = command.match(/\bgit\s+-C\s+([^\s;&|]+)/);
  if (match?.[1]) {
    return match[1].replace(/^['"]|['"]$/g, '');
  }

  const workdir = params?.workdir || params?.cwd || params?.dir;
  if (typeof workdir === 'string' && workdir.trim()) {
    return workdir;
  }

  return process.cwd();
}

function normalizeCommand(command) {
  return ` ${command.replace(/\s+/g, ' ').trim()} `;
}

function isGitPushCommand(command) {
  return /\bgit\b(?:\s+[^;&|]+?)*\s+push\b/.test(normalizeCommand(command));
}

function isForcePushCommand(command) {
  const normalized = normalizeCommand(command);
  const hasForceFlag = /\s--force(?:-with-lease)?\b/.test(normalized) || /\s-f\b/.test(normalized);
  return isGitPushCommand(command) && hasForceFlag;
}

function readCurrentBranch(repoPath) {
  return execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
}

function readOriginRepoSlug(repoPath) {
  const remote = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  return match?.[1] || null;
}

function readPrState(repoPath, branch, logFile) {
  const repo = readOriginRepoSlug(repoPath);
  if (!repo || !branch) {
    appendLog(logFile, `[DEBUG] merged-pr lookup skipped repo=${JSON.stringify(repo)} branch=${JSON.stringify(branch)}`);
    return { merged: false, repo };
  }

  try {
    const output = execFileSync(
      'gh',
      ['pr', 'list', '--repo', repo, '--state', 'all', '--head', branch, '--json', 'number,state,mergedAt,headRefName,baseRefName'],
      { encoding: 'utf8' },
    );
    const data = JSON.parse(output);
    const match = Array.isArray(data) ? data.find((pr) => pr?.headRefName === branch) : null;
    appendLog(logFile, `[DEBUG] merged-pr lookup repo=${JSON.stringify(repo)} branch=${JSON.stringify(branch)} result=${JSON.stringify(match || null)}`);
    return {
      merged: match?.state === 'MERGED' || Boolean(match?.mergedAt),
      prNumber: match?.number,
      repo,
      baseBranch: match?.baseRefName,
    };
  } catch (error) {
    appendLog(logFile, `[DEBUG] merged-pr lookup failed repo=${JSON.stringify(repo)} branch=${JSON.stringify(branch)} error=${JSON.stringify(String(error))}`);
    return { merged: false, repo };
  }
}

function stateFilePath(stateDir, repoPath) {
  const safe = repoPath.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(stateDir, `${safe}.json`);
}

function readDefaultBranch(repoPath) {
  try {
    const ref = execFileSync('git', ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' }).trim();
    return ref.split('/').pop() || null;
  } catch {
    return null;
  }
}

function computeRepoState(repoPath, logFile) {
  const branch = readCurrentBranch(repoPath);
  const repo = readOriginRepoSlug(repoPath);
  const prState = readPrState(repoPath, branch, logFile);
  const checkedAt = new Date().toISOString();
  const checkedAtMs = Date.now();
  const defaultBranch = readDefaultBranch(repoPath);

  return {
    repoPath,
    repo,
    branch,
    defaultBranch,
    checkedAt,
    checkedAtMs,
    pr: {
      number: prState.prNumber || null,
      merged: Boolean(prState.merged),
      baseBranch: prState.baseBranch || null,
    },
  };
}

function writeRepoState(stateDir, repoState) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = stateFilePath(stateDir, repoState.repoPath);
  fs.writeFileSync(filePath, `${JSON.stringify(repoState, null, 2)}\n`);
  return filePath;
}

function readRepoState(stateDir, repoPath) {
  const filePath = stateFilePath(stateDir, repoPath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function hasFreshState(repoState, repoPath, branch, maxAgeMs) {
  if (!repoState) return false;
  if (repoState.repoPath !== repoPath) return false;
  if (repoState.branch !== branch) return false;
  const ageMs = Date.now() - Number(repoState.checkedAtMs || 0);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export default definePluginEntry({
  id: 'repo-guard',
  name: 'Repo Guard',
  description: 'Blocks unsafe git operations before tool execution',
  register(api) {
    const startupLogFile = (api.pluginConfig || {}).logFile || DEFAULT_LOG_FILE;
    appendLog(startupLogFile, `[STARTUP] ${BUILD_SIGNATURE}`);

    api.on('before_tool_call', (event, ctx) => {
      const pluginConfig = api.pluginConfig || {};
      const logFile = pluginConfig.logFile || DEFAULT_LOG_FILE;
      const stateDir = pluginConfig.stateDir || DEFAULT_STATE_DIR;
      const blockForcePush = pluginConfig.blockForcePush !== false;
      const preflightMaxAgeMs = Number(pluginConfig.preflightMaxAgeMs || DEFAULT_PREFLIGHT_MAX_AGE_MS);
      const allowDirectPushRepos = Array.isArray(pluginConfig.allowDirectPushRepos) ? pluginConfig.allowDirectPushRepos : [];

      if (event.toolName !== 'exec') {
        return;
      }

      const command = extractExecCommand(event.params);
      if (!command) {
        return;
      }

      if (!isGitPushCommand(command)) {
        appendLog(logFile, `[ALLOW] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} command=${JSON.stringify(command)}`);
        return;
      }

      const repoPath = extractRepoPath(command, event.params);
      let branch = '';
      try {
        branch = readCurrentBranch(repoPath);
      } catch (error) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=preflight-branch-read-failed repo=${JSON.stringify(repoPath)} error=${JSON.stringify(String(error))}`);
        return {
          block: true,
          blockReason: 'Repo Guard could not verify the current branch before push.',
        };
      }

      if (blockForcePush && isForcePushCommand(command)) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=force-push command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: 'Repo Guard blocked a force push. Use a normal push or create a fresh branch instead.',
        };
      }

      let repoState = readRepoState(stateDir, repoPath);
      const wasFresh = hasFreshState(repoState, repoPath, branch, preflightMaxAgeMs);

      if (!wasFresh) {
        try {
          repoState = computeRepoState(repoPath, logFile);
          const filePath = writeRepoState(stateDir, repoState);
          appendLog(logFile, `[DEBUG] refreshed preflight repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} stateFile=${JSON.stringify(filePath)}`);
        } catch (error) {
          appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=preflight-refresh-failed repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} error=${JSON.stringify(String(error))}`);
          return {
            block: true,
            blockReason: 'Repo Guard could not refresh repo state before push.',
          };
        }
      } else {
        appendLog(logFile, `[DEBUG] using fresh preflight repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} ageMs=${Date.now() - Number(repoState.checkedAtMs || 0)}`);
      }

      if (repoState?.pr?.merged) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=merged-pr-branch repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} pr=${repoState.pr.number || '-'} command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: `Repo Guard blocked a push from merged branch ${branch}${repoState.pr.number ? ` (PR #${repoState.pr.number})` : ''}. Create a fresh branch from the default branch instead.`,
        };
      }

      const isDefaultBranchPush = Boolean(repoState?.defaultBranch) && branch === repoState.defaultBranch;
      const directPushAllowed = allowDirectPushRepos.includes(repoPath);
      if (isDefaultBranchPush && !directPushAllowed) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=default-branch-push repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: `Repo Guard blocked a direct push to default branch ${branch} for ${repoPath}.`,
        };
      }

      appendLog(logFile, `[ALLOW] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} command=${JSON.stringify(command)}`);
      return;
    }, { priority: 100 });
  },
});
