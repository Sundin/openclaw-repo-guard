import path from 'node:path';

const CONTROL_FLOW_BOUNDARY_TOKENS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'done',
  'fi',
  'case',
  'select',
  'while',
  'until',
]);

const SEPARATOR_TOKENS = new Set(['\n', ';', '|', '||', '&&', '(', ')', '{', '}']);

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

export function looksLikeOriginDefaultRef(ref, defaultBranch) {
  if (!ref || !defaultBranch) return false;
  return ref === `origin/${defaultBranch}` || ref === `refs/remotes/origin/${defaultBranch}`;
}

export function looksLikeLocalDefaultRef(ref, defaultBranch) {
  if (!ref || !defaultBranch) return false;
  return ref === defaultBranch || ref === `refs/heads/${defaultBranch}`;
}

function tokenizeShell(command, { preserveSeparators = false } = {}) {
  const tokens = [];
  let current = '';
  let quote = null;

  const flush = () => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      if (char === quote && command[i - 1] !== '\\') {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '\\' && next) {
      current += char;
      current += next;
      i += 1;
      continue;
    }

    if (preserveSeparators) {
      if (char === '\n') {
        flush();
        tokens.push('\n');
        continue;
      }

      if (char === ';') {
        flush();
        tokens.push(';');
        continue;
      }

      if ((char === '&' || char === '|') && next === char) {
        flush();
        tokens.push(`${char}${next}`);
        i += 1;
        continue;
      }

      if (char === '|') {
        flush();
        tokens.push('|');
        continue;
      }

      if (char === '(' || char === ')' || char === '{' || char === '}') {
        flush();
        tokens.push(char);
        continue;
      }
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return tokens;
}

function isEnvAssignmentToken(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function containsInlineShellGitPush(command) {
  return /\b(?:bash|sh|zsh)\b[\s\S]*?\s-l?c\s+["']\s*git(?:\s+-C\s+[^\s"']+)?\s+push\b/.test(command);
}

function containsInlinePythonGitPush(command) {
  return /\bpython(?:3(?:\.\d+)?)?\b/.test(command)
    && /subprocess\.(?:run|Popen|call|check_call|check_output)\s*\(/.test(command)
    && /["']git["']/.test(command)
    && /["']push["']/.test(command);
}

function containsInlineNodeGitPush(command) {
  return /\bnode\b/.test(command)
    && /(?:execFileSync|spawnSync|execSync|spawn)\s*\(/.test(command)
    && /["']git["']/.test(command)
    && /["']push["']/.test(command);
}

export function isWrappedGitPushCommand(command) {
  return containsInlineShellGitPush(command)
    || containsInlinePythonGitPush(command)
    || containsInlineNodeGitPush(command);
}

function isCommandBoundaryToken(token) {

  return SEPARATOR_TOKENS.has(token) || CONTROL_FLOW_BOUNDARY_TOKENS.has(token);
}

function findPreviousSignificantToken(tokens, startIndex) {
  for (let i = startIndex; i >= 0; i -= 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    return token;
  }
  return null;
}

function findGitPushArgs(command) {
  const tokens = tokenizeShell(command, { preserveSeparators: true });

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'git') {
      continue;
    }

    let previousTokenIndex = i - 1;
    while (previousTokenIndex >= 0 && isEnvAssignmentToken(tokens[previousTokenIndex])) {
      previousTokenIndex -= 1;
    }

    const previousToken = findPreviousSignificantToken(tokens, previousTokenIndex);
    if (previousToken !== null && !isCommandBoundaryToken(previousToken)) {
      continue;
    }

    const args = [];
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (isCommandBoundaryToken(token)) {
        break;
      }
      args.push(token);
    }

    const pushIndex = args.indexOf('push');
    if (pushIndex === -1) {
      continue;
    }

    return args.slice(pushIndex + 1);
  }

  return null;
}

export function isGitPushCommand(command) {
  return isWrappedGitPushCommand(command) || findGitPushArgs(command) !== null;
}

function findGitBranchCreateArgs(command) {
  const tokens = tokenizeShell(command, { preserveSeparators: true });

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'git') continue;

    let previousTokenIndex = i - 1;
    while (previousTokenIndex >= 0 && isEnvAssignmentToken(tokens[previousTokenIndex])) {
      previousTokenIndex -= 1;
    }

    const previousToken = findPreviousSignificantToken(tokens, previousTokenIndex);
    if (previousToken !== null && !isCommandBoundaryToken(previousToken)) {
      continue;
    }

    const args = [];
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (isCommandBoundaryToken(token)) break;
      args.push(token);
    }

    const subcommand = args[0];
    if (subcommand !== 'checkout' && subcommand !== 'switch') {
      continue;
    }

    const createFlags = subcommand === 'checkout' ? new Set(['-b', '-B']) : new Set(['-c', '-C']);
    for (let k = 1; k < args.length; k += 1) {
      if (!createFlags.has(args[k])) continue;
      const newBranch = args[k + 1] || null;
      const startPoint = args[k + 2] || null;
      if (!newBranch) return null;
      return { subcommand, newBranch, startPoint };
    }
  }

  return null;
}

export function parseGitBranchCreate(command) {
  return findGitBranchCreateArgs(command);
}

export function isGitBranchCreateCommand(command) {
  return findGitBranchCreateArgs(command) !== null;
}

export function isForcePushCommand(command) {
  const args = findGitPushArgs(command);
  if (!args) {
    return false;
  }
  const normalized = normalizeCommand(args.join(' '));
  return /\s--force(?:-with-lease)?\b/.test(normalized) || /\s-f\b/.test(normalized);
}

export function parsePushTargetBranch(command) {
  const args = findGitPushArgs(command);
  if (!args) {
    return null;
  }

  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token.startsWith('-')) {
      if (
        token === '--repo' ||
        token === '--receive-pack' ||
        token === '--exec'
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
