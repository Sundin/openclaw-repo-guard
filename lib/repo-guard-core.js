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

function splitTopLevelCommands(command) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';' || char === '|') {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = '';
      continue;
    }

    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = '';
      i += 1;
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function tokenizeShell(command) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

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

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function gitPushArgs(command) {
  const tokens = tokenizeShell(command);
  let index = 0;

  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
    index += 1;
  }

  const gitIndex = tokens.findIndex((token, tokenIndex) => tokenIndex >= index && token === 'git');
  const pushIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > gitIndex && token === 'push');
  if (gitIndex === -1 || pushIndex === -1 || gitIndex !== index) {
    return null;
  }

  return tokens.slice(pushIndex + 1);
}

export function isGitPushCommand(command) {
  return splitTopLevelCommands(command).some((segment) => gitPushArgs(segment) !== null);
}

export function isForcePushCommand(command) {
  return splitTopLevelCommands(command).some((segment) => {
    const args = gitPushArgs(segment);
    if (!args) {
      return false;
    }
    const normalized = normalizeCommand(args.join(' '));
    return /\s--force(?:-with-lease)?\b/.test(normalized) || /\s-f\b/.test(normalized);
  });
}

export function parsePushTargetBranch(command) {
  const args = splitTopLevelCommands(command)
    .map((segment) => gitPushArgs(segment))
    .find((value) => value !== null);
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
