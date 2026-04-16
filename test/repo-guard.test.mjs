import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractExecCommand,
  extractRepoPath,
  normalizeCommand,
  isGitPushCommand,
  isForcePushCommand,
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

test('extractRepoPath falls back to workdir when no git -C is present', () => {
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

test('isForcePushCommand detects force push variants', () => {
  assert.equal(isForcePushCommand('git push --force origin master'), true);
  assert.equal(isForcePushCommand('git push --force-with-lease origin branch'), true);
  assert.equal(isForcePushCommand('git push -f origin branch'), true);
  assert.equal(isForcePushCommand('git push origin branch'), false);
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
