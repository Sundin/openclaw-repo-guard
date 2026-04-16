import path from 'node:path';

export function extractExecCommand(params) {
  const candidates = [params?.command, params?.cmd, params?.script];
  return candidates.find((value) => typeof value === 'string') || '';
}

export function extractRepoPath(command, params) {
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

export function normalizeCommand(command) {
  return ` ${command.replace(/\s+/g, ' ').trim()} `;
}

export function isGitPushCommand(command) {
  return /\bgit\b(?:\s+[^;&|]+?)*\s+push\b/.test(normalizeCommand(command));
}

export function isForcePushCommand(command) {
  const normalized = normalizeCommand(command);
  const hasForceFlag = /\s--force(?:-with-lease)?\b/.test(normalized) || /\s-f\b/.test(normalized);
  return isGitPushCommand(command) && hasForceFlag;
}

export function parsePushTargetBranch(command) {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const tokens = normalized.split(' ');
  const gitIndex = tokens.findIndex((token) => token === 'git');
  const pushIndex = tokens.findIndex((token, index) => index > gitIndex && token === 'push');
  if (gitIndex === -1 || pushIndex === -1) {
    return null;
  }

  const commandTokens = [];
  for (let i = gitIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (i > pushIndex && (token === '&&' || token === '||' || token === ';' || token === '|')) {
      break;
    }
    commandTokens.push(token);
  }

  const args = commandTokens.slice(pushIndex - gitIndex + 1);
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token.startsWith('-')) {
      if (
        token === '-u' ||
        token === '--set-upstream' ||
        token === '--repo' ||
        token === '--receive-pack' ||
        token === '--exec' ||
        token === '-C'
      ) {
        i += 1;
      }
      continue;
    }
    positionals.push(token);
  }

  if (positionals.length < 2) {
    return null;
  }

  const ref = positionals[positionals.length - 1].replace(/^['"]|['"]$/g, '');
  if (!ref || ref === 'HEAD') {
    return null;
  }
  if (ref.includes(':')) {
    return ref.split(':').pop() || null;
  }
  return ref;
}

export function stateFilePath(stateDir, repoPath) {
  const safe = repoPath.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(stateDir, `${safe}.json`);
}

export function hasFreshState(repoState, repoPath, branch, maxAgeMs) {
  if (!repoState) return false;
  if (repoState.repoPath !== repoPath) return false;
  if (repoState.branch !== branch) return false;
  const ageMs = Date.now() - Number(repoState.checkedAtMs || 0);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}
