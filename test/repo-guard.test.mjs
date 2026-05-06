import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  isGitHubForceRefUpdateCommand,
  parsePushTargetBranch,
  stateFilePath,
  hasFreshState,
} from '../lib/repo-guard-core.js';

test('extractExecCommand returns first supported command field', () => {
  assert.equal(extractExecCommand({ command: 'git push' }), 'git push');
  assert.equal(extractExecCommand({ cmd: 'echo hi' }), 'echo hi');
  assert.equal(extractExecCommand({ script: 'pwd' }), 'pwd');
  assert.equal(extractExecCommand({}), '');
});

test('extractRepoPath prefers git -C path', () => {
  assert.equal(
    extractRepoPath('git -C /tmp/repo push origin master', {}),
    '/tmp/repo',
  );
  assert.equal(
    extractRepoPath('git -C "./quoted-repo" push', {}),
    './quoted-repo',
  );
});

test('extractRepoPath uses top-level cd prefixes before falling back to workdir', () => {
  assert.equal(
    extractRepoPath('cd /tmp/repo && git push origin master', { workdir: '/work/tree' }),
    '/tmp/repo',
  );
  assert.equal(
    extractRepoPath('cd "./quoted repo" && git checkout -b feature/test', {}),
    './quoted repo',
  );
  assert.equal(
    extractRepoPath('cd /tmp/one && cd /tmp/two && git push origin feature/test', {}),
    '/tmp/two',
  );
  assert.equal(
    extractRepoPath('cd /tmp/repo\ngit push origin feature/line-break', { workdir: '/work/tree' }),
    '/tmp/repo',
  );
  assert.equal(
    extractRepoPath('git push origin master', { workdir: '/work/tree' }),
    '/work/tree',
  );
});

test('normalizeCommand collapses whitespace safely', () => {
  assert.equal(normalizeCommand(' git   push\n origin   master '), ' git push origin master ');
});

test('isGitPushCommand detects push commands and ignores non-push commands', () => {
  assert.equal(isGitPushCommand('git push origin master'), true);
  assert.equal(isGitPushCommand('git -C /tmp/repo push -u origin feature/test'), true);
  assert.equal(isGitPushCommand('FOO=bar git push origin master'), true);
  assert.equal(isGitPushCommand('git status'), false);
  assert.equal(isGitPushCommand('gh pr create'), false);
});

test('isGitPushCommand ignores embedded git push strings in non-push commands', () => {
  assert.equal(isGitPushCommand('echo git push origin master'), false);
  assert.equal(isGitPushCommand('printf "git push origin master\\n"'), false);
  assert.equal(isGitPushCommand('node -e "console.log(\'git push origin master\')"'), false);
  assert.equal(isGitPushCommand('git commit -m "prepare git push origin master"'), false);
  assert.equal(isGitPushCommand('bash -lc "git status && echo git push origin master"'), false);
});



test('isWrappedGitPushCommand detects inline wrapper bypass patterns', () => {
  assert.equal(isWrappedGitPushCommand(`python3 - <<'PY'
import subprocess
subprocess.run(['git', 'push'], check=True)
PY`), true);
  assert.equal(isWrappedGitPushCommand(`python3 -c "import subprocess; subprocess.run(['git','push'], check=True)"`), true);
  assert.equal(isWrappedGitPushCommand(`node -e "require('node:child_process').execFileSync('git', ['push'])"`), true);
  assert.equal(isWrappedGitPushCommand(`bash -lc 'git push origin branch'`), true);
  assert.equal(isWrappedGitPushCommand(`python3 -c "print('git push origin master')"`), false);
  assert.equal(isWrappedGitPushCommand(`node -e "console.log('git push origin master')"`), false);
});

test('isWrappedGitPushCommand detects git push buried inside local script files', () => {
  const tmpDir = fs.mkdtempSync('/tmp/repo-guard-script-');
  const pyScript = `${tmpDir}/push.py`;
  const shScript = `${tmpDir}/push.sh`;
  const safePyScript = `${tmpDir}/safe.py`;

  fs.writeFileSync(pyScript, `import subprocess\nsubprocess.run(['git', 'push', '--force-with-lease', 'origin', 'feature/test'], check=True)\n`);
  fs.writeFileSync(shScript, '#!/usr/bin/env bash\ngit push --force-with-lease origin feature/test\n');
  fs.writeFileSync(safePyScript, 'print("hello")\n');

  assert.equal(isWrappedGitPushCommand(`python3 ${pyScript}`), true);
  assert.equal(isWrappedGitPushCommand(`bash ${shScript}`), true);
  assert.equal(isWrappedGitPushCommand(`python3 ${safePyScript}`), false);
});

test('isGitPushCommand detects git push in later top-level chained segments', () => {
  assert.equal(isGitPushCommand('npm test && git push origin master'), true);
  assert.equal(isGitPushCommand('echo ready; git push origin release'), true);
  assert.equal(isGitPushCommand('false || git push origin hotfix'), true);
});

test('isGitPushCommand detects git push inside multiline shell scripts and loop bodies', () => {
  assert.equal(
    isGitPushCommand(`set -e\ncd /tmp/repo\ngit push origin feature/line-break`),
    true,
  );
  assert.equal(
    isGitPushCommand(
      'for branch in feature/foo feature/bar; do git push --force-with-lease origin "$branch"; done',
    ),
    true,
  );
  assert.equal(
    isGitPushCommand(`for branch in feature/foo feature/bar; do\n  git push --force-with-lease origin "$branch"\ndone`),
    true,
  );
});

test('isGitPushCommand ignores quoted or escaped separators inside segments', () => {
  assert.equal(isGitPushCommand('printf "done && still quoted" && git push origin master'), true);
  assert.equal(isGitPushCommand('echo one\;two && git push origin master'), true);
  assert.equal(isGitPushCommand('echo one\|two && git push origin master'), true);
  assert.equal(isGitPushCommand('printf "git push origin master && nope"'), false);
});

test('isForcePushCommand detects force push variants', () => {
  assert.equal(isForcePushCommand('git push --force origin master'), true);
  assert.equal(isForcePushCommand('git push --force-with-lease origin branch'), true);
  assert.equal(isForcePushCommand('git push -f origin branch'), true);
  assert.equal(
    isForcePushCommand(
      'for branch in feature/foo feature/bar; do git push --force-with-lease origin "$branch"; done',
    ),
    true,
  );
  assert.equal(isForcePushCommand('git push origin branch'), false);
});

test('isGitHubForceRefUpdateCommand detects forced GitHub refs API branch rewrites', () => {
  assert.equal(
    isGitHubForceRefUpdateCommand(
      `curl -sS -X PATCH https://api.github.com/repos/varghand/admin-tool/git/refs/heads/fix/issue-159 -d '{"sha":"abc123","force":true}'`,
    ),
    true,
  );
  assert.equal(
    isGitHubForceRefUpdateCommand(
      `gh api --method PATCH repos/varghand/admin-tool/git/refs/heads/fix/issue-159 --input - <<'EOF'\n{"sha":"abc123","force":true}\nEOF`,
    ),
    true,
  );
  assert.equal(
    isGitHubForceRefUpdateCommand(
      `curl -sS -X PATCH https://api.github.com/repos/varghand/admin-tool/git/refs/heads/fix/issue-159 -d '{"sha":"abc123","force":false}'`,
    ),
    false,
  );
  assert.equal(
    isGitHubForceRefUpdateCommand('curl -sS https://api.github.com/repos/varghand/admin-tool/pulls'),
    false,
  );
});

test('parsePushTargetBranch handles standard remote plus branch syntax', () => {
  assert.equal(
    parsePushTargetBranch('git -C /tmp/repo push -u origin fix/my-branch'),
    'fix/my-branch',
  );
  assert.equal(
    parsePushTargetBranch('git push origin master'),
    'master',
  );
});

test('debug parser standard syntax fixture', () => {
  const command = 'git -C /tmp/repo push -u origin fix/my-branch';
  const normalized = command.replace(/\s+/g, ' ').trim();
  assert.equal(normalized, 'git -C /tmp/repo push -u origin fix/my-branch');
  assert.equal(parsePushTargetBranch(command), 'fix/my-branch');
});

test('parsePushTargetBranch handles refspec pushes', () => {
  assert.equal(
    parsePushTargetBranch('git push origin HEAD:fix/my-branch'),
    'fix/my-branch',
  );
  assert.equal(
    parsePushTargetBranch('git push origin localbranch:main'),
    'main',
  );
});

test('parsePushTargetBranch returns null when no explicit branch is present', () => {
  assert.equal(parsePushTargetBranch('git push'), null);
  assert.equal(parsePushTargetBranch('git push origin HEAD'), null);
});

test('parsePushTargetBranch ignores chained commands after push', () => {
  assert.equal(
    parsePushTargetBranch('git push -u origin fix/my-branch && gh pr create'),
    'fix/my-branch',
  );
  assert.equal(
    parsePushTargetBranch('git push origin master ; echo done'),
    'master',
  );
});

test('parsePushTargetBranch finds push branch in later chained segments', () => {
  assert.equal(
    parsePushTargetBranch('npm test && git push origin feature/chain'),
    'feature/chain',
  );
  assert.equal(
    parsePushTargetBranch('echo prep || git push origin release/v2'),
    'release/v2',
  );
});

test('parsePushTargetBranch detects branch targets inside loop bodies', () => {
  assert.equal(
    parsePushTargetBranch(
      'for branch in feature/foo feature/bar; do git push --force-with-lease origin "$branch"; done',
    ),
    '$branch',
  );
  assert.equal(
    parsePushTargetBranch(`for branch in feature/foo; do\n  git push origin hotfix/$branch\ndone`),
    'hotfix/$branch',
  );
});

test('parsePushTargetBranch ignores quoted or escaped separators near push arguments', () => {
  assert.equal(
    parsePushTargetBranch('printf "done && still quoted" && git push origin feature/quoted'),
    'feature/quoted',
  );
  assert.equal(
    parsePushTargetBranch('echo one\;two && git push origin feature/escaped'),
    'feature/escaped',
  );
});

test('isGitBranchCreateCommand detects checkout/switch/branch creation flows', () => {
  assert.equal(isGitBranchCreateCommand('git checkout -b feature/test'), true);
  assert.equal(isGitBranchCreateCommand('git checkout -B feature/test origin/master'), true);
  assert.equal(isGitBranchCreateCommand('git switch -c feature/test'), true);
  assert.equal(isGitBranchCreateCommand('git switch -C feature/test origin/master'), true);
  assert.equal(isGitBranchCreateCommand('git branch feature/test'), true);
  assert.equal(isGitBranchCreateCommand('git branch feature/test origin/master'), true);
  assert.equal(isGitBranchCreateCommand('git checkout master'), false);
  assert.equal(isGitBranchCreateCommand('git switch master'), false);
  assert.equal(isGitBranchCreateCommand('git branch --show-current'), false);
});

test('parseGitBranchCreate parses new branch and optional start point', () => {
  assert.deepEqual(parseGitBranchCreate('git checkout -b feature/test'), {
    subcommand: 'checkout',
    newBranch: 'feature/test',
    startPoint: null,
  });
  assert.deepEqual(parseGitBranchCreate('git checkout -B feature/test origin/master'), {
    subcommand: 'checkout',
    newBranch: 'feature/test',
    startPoint: 'origin/master',
  });
  assert.deepEqual(parseGitBranchCreate('git switch -c feature/test master'), {
    subcommand: 'switch',
    newBranch: 'feature/test',
    startPoint: 'master',
  });
  assert.deepEqual(parseGitBranchCreate('git branch feature/test origin/master'), {
    subcommand: 'branch',
    newBranch: 'feature/test',
    startPoint: 'origin/master',
  });
});

test('default-branch ref helpers match local and remote default refs', () => {
  assert.equal(looksLikeOriginDefaultRef('origin/master', 'master'), true);
  assert.equal(looksLikeOriginDefaultRef('refs/remotes/origin/master', 'master'), true);
  assert.equal(looksLikeOriginDefaultRef('master', 'master'), false);
  assert.equal(looksLikeLocalDefaultRef('master', 'master'), true);
  assert.equal(looksLikeLocalDefaultRef('refs/heads/master', 'master'), true);
  assert.equal(looksLikeLocalDefaultRef('origin/master', 'master'), false);
});

test('stateFilePath creates deterministic safe file names', () => {
  assert.equal(
    stateFilePath('/state', '/home/ubuntu/.openclaw/plugins/repo-guard'),
    '/state/_home_ubuntu_.openclaw_plugins_repo-guard.json',
  );
});

test('hasFreshState validates repo, branch, and age window', () => {
  const now = Date.now();
  const valid = {
    repoPath: '/tmp/repo',
    branch: 'feature/test',
    checkedAtMs: now - 5000,
  };
  assert.equal(hasFreshState(valid, '/tmp/repo', 'feature/test', 10000), true);
  assert.equal(hasFreshState(valid, '/tmp/repo', 'other-branch', 10000), false);
  assert.equal(hasFreshState(valid, '/tmp/other', 'feature/test', 10000), false);
  assert.equal(hasFreshState(valid, '/tmp/repo', 'feature/test', 1000), false);
});

test('plugin refreshes origin before computing branch freshness state', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /function refreshOrigin\(repoPath\)/);
  assert.match(source, /git', \['-C', repoPath, 'fetch', 'origin', '--prune'\]/);
  const refreshCall = source.indexOf('refreshOrigin(repoPath);');
  const defaultHeadRead = source.indexOf('defaultBranchHead = readCommit(repoPath, defaultRemoteRef);');
  assert.notEqual(refreshCall, -1);
  assert.notEqual(defaultHeadRead, -1);
  assert.ok(refreshCall < defaultHeadRead, 'origin should refresh before comparing branch against origin/default');
});


test('plugin source blocks wrapped git pushes before repo preflight', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const wrappedBlock = source.indexOf('if (wrappedGitPush)');
  const repoPathRead = source.indexOf('const repoPath = resolveRepoRoot(extractRepoPath(command, event.params));');
  assert.notEqual(wrappedBlock, -1);
  assert.notEqual(repoPathRead, -1);
  assert.ok(wrappedBlock < repoPathRead, 'wrapped-push block should run before repo path preflight');
  assert.match(source, /Repo Guard blocked a wrapped git push/);
});


test('plugin source blocks forced GitHub ref updates before repo preflight', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const githubRefBlock = source.indexOf('if (githubForceRefUpdate)');
  const repoPathRead = source.indexOf('const repoPath = resolveRepoRoot(extractRepoPath(command, event.params));');
  assert.notEqual(githubRefBlock, -1);
  assert.notEqual(repoPathRead, -1);
  assert.ok(githubRefBlock < repoPathRead, 'github ref update block should run before repo path preflight');
  assert.match(source, /blocked a forced GitHub branch ref update/);
});


test('plugin source blocks stale local default branch checkout before new branch creation', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /isGitBranchCreateCommand/);
  assert.match(source, /reason=stale-default-branch-create/);
  assert.match(source, /blocked new branch creation because it was not starting from a freshly updated/);
});

test('plugin source returns after branch creation guard passes so push-only rules do not fire', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const branchCreateBlock = source.indexOf('if (isBranchCreateCommand) {');
  const branchCreateAllow = source.indexOf('reason=branch-create-guard-passed');
  const mergedPrCheck = source.indexOf('if (repoState?.pr?.merged) {');
  assert.notEqual(branchCreateBlock, -1);
  assert.notEqual(branchCreateAllow, -1);
  assert.notEqual(mergedPrCheck, -1);
  assert.ok(branchCreateBlock < branchCreateAllow, 'branch-create allow log should be inside branch-create block');
  assert.ok(branchCreateAllow < mergedPrCheck, 'branch-create handling should return before push-only checks');
});

test('plugin source normalizes subdirectory workdirs to repo root before allowlist checks', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /function resolveRepoRoot\(repoPath\)/);
  assert.match(source, /'rev-parse', '--show-toplevel'/);
  assert.match(source, /const repoPath = resolveRepoRoot\(extractRepoPath\(command, event.params\)\);/);
});
