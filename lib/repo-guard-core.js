import fs from 'node:fs';
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

function stripHeredocBodies(command) {
  const heredocPattern = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  const lines = command.split('\n');
  const sanitized = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    sanitized.push(line);

    const delimiters = [];
    heredocPattern.lastIndex = 0;
    let match = heredocPattern.exec(line);
    while (match) {
      delimiters.push(match[2]);
      match = heredocPattern.exec(line);
    }

    for (const delimiter of delimiters) {
      i += 1;
      while (i < lines.length && lines[i].trim() !== delimiter) {
        i += 1;
      }
      if (i < lines.length) {
        sanitized.push(lines[i]);
      }
    }
  }

  return sanitized.join('\n');
}

function extractCdRepoPath(command) {
  const tokens = tokenizeShell(stripHeredocBodies(command), { preserveSeparators: true });
  let currentDir = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || isCommandBoundaryToken(token)) {
      continue;
    }

    if (token === 'cd') {
      const target = tokens[i + 1];
      if (target && !isCommandBoundaryToken(target)) {
        currentDir = target;
        i += 1;
      }
      continue;
    }

    if (token === 'git') {
      return currentDir;
    }
  }

  return null;
}

export function extractRepoPath(command, params) {
  const sanitizedCommand = stripHeredocBodies(command);
  const match = sanitizedCommand.match(/\bgit\s+-C\s+([^\s;&|]+)/);
  if (match?.[1]) {
    return match[1].replace(/^['"]|['"]$/g, '');
  }

  const cdRepoPath = extractCdRepoPath(command);
  if (cdRepoPath) {
    return cdRepoPath;
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
  return /\b(?:bash|sh|zsh)\b[\s\S]*?\s-l?c\s+["']\s*git(?:\s+-C\s+[^\s"']+)?\s+push\b/.test(command)
    || /\b(?:bash|sh|zsh)\b[\s\S]*?<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\bgit(?:\s+-C\s+[^\s"']+)?\s+push\b[\s\S]*?(?:^|\n)\2(?=\s*(?:\n|$))/m.test(command);
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

function resolveScriptPath(command, workdir) {
  const tokens = tokenizeShell(command);
  if (tokens.length < 2) return null;

  const interpreter = tokens[0];
  const isPython = /^python(?:3(?:\.\d+)?)?$/.test(interpreter);
  const isNode = interpreter === 'node';
  const isShell = /^(?:bash|sh|zsh)$/.test(interpreter);
  if (!isPython && !isNode && !isShell) return null;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (isPython) {
      if (token === '-c' || token === '-m' || token === '-') return null;
      if (token.startsWith('-')) continue;
      return path.isAbsolute(token) ? token : path.join(workdir || process.cwd(), token);
    }

    if (isNode) {
      if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') return null;
      if (token.startsWith('-')) continue;
      return path.isAbsolute(token) ? token : path.join(workdir || process.cwd(), token);
    }

    if (isShell) {
      if (token === '-c' || token === '-lc' || token === '-l' || token === '-s') return null;
      if (token.startsWith('-')) continue;
      return path.isAbsolute(token) ? token : path.join(workdir || process.cwd(), token);
    }
  }

  return null;
}

function containsScriptFileGitPush(command, workdir) {
  const scriptPath = resolveScriptPath(command, workdir);
  if (!scriptPath || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    return false;
  }

  let content = '';
  try {
    content = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return false;
  }

  if (/^python(?:3(?:\.\d+)?)?\b/.test(command)) {
    return /subprocess\.(?:run|Popen|call|check_call|check_output)\s*\(/.test(content)
      && /["']git["']/.test(content)
      && /["']push["']/.test(content);
  }

  if (/^node\b/.test(command)) {
    return /(?:execFileSync|spawnSync|execSync|spawn)\s*\(/.test(content)
      && /["']git["']/.test(content)
      && /["']push["']/.test(content);
  }

  if (/^(?:bash|sh|zsh)\b/.test(command)) {
    return /\bgit(?:\s+-C\s+[^\s"']+)?\s+push\b/.test(content);
  }

  return false;
}

export function isWrappedGitPushCommand(command, options = {}) {
  return containsInlineShellGitPush(command)
    || containsInlinePythonGitPush(command)
    || containsInlineNodeGitPush(command)
    || containsScriptFileGitPush(command, options.workdir);
}

export function isGitHubForceRefUpdateCommand(command) {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const targetsGitRefsApi = /(?:curl|gh\s+api)\b[\s\S]*\/git\/refs\/heads\//.test(normalized);
  if (!targetsGitRefsApi) {
    return false;
  }

  const forceFlagPatterns = [
    /"force"\s*:\s*true/i,
    /'force'\s*:\s*true/i,
    /force=true/i,
    /--method\s+PATCH\b[\s\S]*\/git\/refs\/heads\//i,
    /-X\s+PATCH\b[\s\S]*\/git\/refs\/heads\//i,
  ];

  const hasExplicitForce = forceFlagPatterns.slice(0, 3).some((pattern) => pattern.test(normalized));
  const isPatchRefUpdate = forceFlagPatterns.slice(3).some((pattern) => pattern.test(normalized));

  return hasExplicitForce && isPatchRefUpdate;
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
  const tokens = tokenizeShell(stripHeredocBodies(command), { preserveSeparators: true });

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
  const tokens = tokenizeShell(stripHeredocBodies(command), { preserveSeparators: true });

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
    if (subcommand === 'checkout' || subcommand === 'switch') {
      const createFlags = subcommand === 'checkout' ? new Set(['-b', '-B']) : new Set(['-c', '-C']);
      for (let k = 1; k < args.length; k += 1) {
        if (!createFlags.has(args[k])) continue;
        const newBranch = args[k + 1] || null;
        const startPoint = args[k + 2] || null;
        if (!newBranch) return null;
        return { subcommand, newBranch, startPoint };
      }
      continue;
    }

    if (subcommand === 'branch') {
      const filteredArgs = args.slice(1).filter((arg) => !arg.startsWith('-'));
      const newBranch = filteredArgs[0] || null;
      const startPoint = filteredArgs[1] || null;
      if (!newBranch) {
        continue;
      }
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
  if (isGitHubForceRefUpdateCommand(command)) {
    return true;
  }

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
