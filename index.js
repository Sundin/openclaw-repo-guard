import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  extractExecCommand,
  extractRepoPath,
  normalizeCommand,
  isGitPushCommand,
  isGitBranchCreateCommand,
  parseGitBranchCreate,
  looksLikeOriginDefaultRef,
  looksLikeLocalDefaultRef,
  isWrappedGitPushCommand,
  isForcePushCommand,
  parsePushTargetBranch,
  stateFilePath,
  hasFreshState,
} from './lib/repo-guard-core.js';

const DEFAULT_STATE_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'state');
const DEFAULT_LOG_FILE = path.join(process.env.HOME || '/tmp', '.openclaw', 'logs', 'repo-guard.log');
const DEFAULT_PREFLIGHT_MAX_AGE_MS = 60 * 1000;
const BUILD_SIGNATURE = 'repo-guard build 0.1.13-normalize-repo-root-allowlist 2026-04-24T09:22Z';

function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function readCurrentBranch(repoPath) {
  return execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
}

function resolveRepoRoot(repoPath) {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return repoPath;
  }
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


function readDefaultBranch(repoPath) {
  try {
    const ref = execFileSync('git', ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' }).trim();
    return ref.split('/').pop() || null;
  } catch {
    try {
      const remoteShow = execFileSync('git', ['-C', repoPath, 'remote', 'show', 'origin'], { encoding: 'utf8' });
      const match = remoteShow.match(/HEAD branch:\s+(\S+)/);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }
}

function readMergeBase(repoPath, branchA, branchB) {
  return execFileSync('git', ['-C', repoPath, 'merge-base', branchA, branchB], { encoding: 'utf8' }).trim();
}

function readCommit(repoPath, ref) {
  return execFileSync('git', ['-C', repoPath, 'rev-parse', ref], { encoding: 'utf8' }).trim();
}

function refreshOrigin(repoPath) {
  execFileSync('git', ['-C', repoPath, 'fetch', 'origin', '--prune'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function computeRepoState(repoPath, logFile) {
  refreshOrigin(repoPath);
  const branch = readCurrentBranch(repoPath);
  const repo = readOriginRepoSlug(repoPath);
  const prState = readPrState(repoPath, branch, logFile);
  const checkedAt = new Date().toISOString();
  const checkedAtMs = Date.now();
  const defaultBranch = readDefaultBranch(repoPath);
  const defaultRemoteRef = defaultBranch ? `origin/${defaultBranch}` : null;

  let defaultBranchHead = null;
  let branchDefaultMergeBase = null;
  if (defaultRemoteRef) {
    defaultBranchHead = readCommit(repoPath, defaultRemoteRef);
    branchDefaultMergeBase = readMergeBase(repoPath, branch, defaultRemoteRef);
  }

  return {
    repoPath,
    repo,
    branch,
    defaultBranch,
    defaultBranchHead,
    branchDefaultMergeBase,
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
      const requireUpToDateDefaultBase = pluginConfig.requireUpToDateDefaultBase !== false;
      const preflightMaxAgeMs = Number(pluginConfig.preflightMaxAgeMs || DEFAULT_PREFLIGHT_MAX_AGE_MS);
      const allowDirectPushRepos = Array.isArray(pluginConfig.allowDirectPushRepos) ? pluginConfig.allowDirectPushRepos : [];

      if (event.toolName !== 'exec') {
        return;
      }

      const command = extractExecCommand(event.params);
      if (!command) {
        return;
      }

      const isPushCommand = isGitPushCommand(command);
      const isBranchCreateCommand = isGitBranchCreateCommand(command);

      if (!isPushCommand && !isBranchCreateCommand) {
        appendLog(logFile, `[ALLOW] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} command=${JSON.stringify(command)}`);
        return;
      }

      if (isWrappedGitPushCommand(command)) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=wrapped-git-push command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: 'Repo Guard blocked a wrapped git push. Do not hide git push inside inline Python, Node, or shell wrapper commands. Run git push directly so Repo Guard can verify the real repo and branch.',
        };
      }

      const repoPath = resolveRepoRoot(extractRepoPath(command, event.params));
      const pushTargetBranch = parsePushTargetBranch(command);
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

      if (pushTargetBranch && pushTargetBranch !== branch) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=branch-target-mismatch repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} pushTargetBranch=${JSON.stringify(pushTargetBranch)} command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: `Repo Guard blocked a push because the checked out branch ${branch} does not match the push target ${pushTargetBranch}. Switch to the branch you intend to push first.`,
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
            blockReason: 'Repo Guard could not refresh repo state from origin before push.',
          };
        }
      } else {
        appendLog(logFile, `[DEBUG] using fresh preflight repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} ageMs=${Date.now() - Number(repoState.checkedAtMs || 0)}`);
      }

      if (isBranchCreateCommand) {
        const branchCreate = parseGitBranchCreate(command);
        const defaultBranch = repoState?.defaultBranch || null;
        const defaultRemoteRef = defaultBranch ? `origin/${defaultBranch}` : null;
        const currentCommit = readCommit(repoPath, 'HEAD');
        const defaultHead = defaultRemoteRef ? readCommit(repoPath, defaultRemoteRef) : null;
        const startPoint = branchCreate?.startPoint || null;
        const startsFromOriginDefault = looksLikeOriginDefaultRef(startPoint, defaultBranch);
        const startsFromLocalDefault = looksLikeLocalDefaultRef(startPoint, defaultBranch);
        const implicitFromCurrentBranch = !startPoint;
        const currentBranchIsDefault = Boolean(defaultBranch) && branch === defaultBranch;
        const currentBranchFresh = Boolean(defaultHead) && currentCommit === defaultHead;
        const localDefaultFresh = Boolean(defaultHead) && Boolean(defaultBranch) && readCommit(repoPath, defaultBranch) === defaultHead;

        const allowed = startsFromOriginDefault
          || (startsFromLocalDefault && localDefaultFresh)
          || (implicitFromCurrentBranch && currentBranchIsDefault && currentBranchFresh);

        if (!allowed) {
          appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=stale-default-branch-create repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} defaultBranch=${JSON.stringify(defaultBranch)} startPoint=${JSON.stringify(startPoint)} command=${JSON.stringify(command)}`);
          return {
            block: true,
            blockReason: `Repo Guard blocked new branch creation because it was not starting from a freshly updated ${defaultBranch || 'default branch'}. Refresh/switch to the latest origin/${defaultBranch || 'default'} first, or create the branch explicitly from origin/${defaultBranch || 'default'}.`,
          };
        }
      }

      if (repoState?.pr?.merged) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=merged-pr-branch repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} pr=${repoState.pr.number || '-'} command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: `Repo Guard blocked a push from merged branch ${branch}${repoState.pr.number ? ` (PR #${repoState.pr.number})` : ''}. Create a fresh branch from the default branch instead.`,
        };
      }

      const effectiveBranch = pushTargetBranch || branch;
      const inferredProtectedDefaultBranch = !repoState?.defaultBranch && (effectiveBranch === 'master' || effectiveBranch === 'main');
      const isDefaultBranchPush = (Boolean(repoState?.defaultBranch) && effectiveBranch === repoState.defaultBranch) || inferredProtectedDefaultBranch;
      const directPushAllowed = allowDirectPushRepos.includes(repoPath);
      appendLog(logFile, `[DEBUG] push-policy repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} effectiveBranch=${JSON.stringify(effectiveBranch)} pushTargetBranch=${JSON.stringify(pushTargetBranch)} defaultBranch=${JSON.stringify(repoState?.defaultBranch || null)} inferredProtectedDefaultBranch=${JSON.stringify(inferredProtectedDefaultBranch)} isDefaultBranchPush=${JSON.stringify(isDefaultBranchPush)} directPushAllowed=${JSON.stringify(directPushAllowed)} allowDirectPushRepos=${JSON.stringify(allowDirectPushRepos)}`);
      if (isDefaultBranchPush && !directPushAllowed) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=default-branch-push repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: `Repo Guard blocked a direct push to protected default branch ${effectiveBranch} for ${repoPath}. Only explicitly allowlisted repo paths may push directly to the default branch.`,
        };
      }

      if (
        requireUpToDateDefaultBase &&
        !isDefaultBranchPush &&
        repoState?.defaultBranchHead &&
        repoState?.branchDefaultMergeBase &&
        repoState.defaultBranchHead !== repoState.branchDefaultMergeBase
      ) {
        appendLog(logFile, `[BLOCK] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} reason=stale-default-base repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} defaultBranch=${JSON.stringify(repoState.defaultBranch)} defaultHead=${JSON.stringify(repoState.defaultBranchHead)} mergeBase=${JSON.stringify(repoState.branchDefaultMergeBase)} command=${JSON.stringify(command)}`);
        return {
          block: true,
          blockReason: `Repo Guard blocked a push from ${branch} because it is not based on the latest origin/${repoState.defaultBranch}. Fetch/rebase or create a fresh branch from the updated default branch first.`,
        };
      }

      appendLog(logFile, `[ALLOW] tool=exec session=${ctx.sessionKey || '-'} run=${event.runId || '-'} repo=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} command=${JSON.stringify(command)}`);
      return;
    }, { priority: 100 });
  },
});
