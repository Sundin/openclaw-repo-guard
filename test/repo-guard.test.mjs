import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  extractExecCommand,
  extractRepoPath,
  normalizeCommand,
  isGitPushCommand,
  isWrappedGitPushCommand,
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
  assert.equal(isGitPushCommand('git stash push -u'), false);
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

test('isGitPushCommand detects git push in later top-level chained segments', () => {
  assert.equal(isGitPushCommand('npm test && git push origin master'), true);
  assert.equal(isGitPushCommand('echo ready; git push origin release'), true);
  assert.equal(isGitPushCommand('false || git push origin hotfix'), true);
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
  assert.equal(isForcePushCommand('git stash push --force'), false);
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
  assert.equal(parsePushTargetBranch('git stash push -u'), null);
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

test('plugin source makes force push non-bypassable even for allowlisted repos', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const forceBlock = source.indexOf('if (isForcePushCommand(command))');
  const directPushPolicy = source.indexOf('if (isDefaultBranchPush && !directPushAllowed)');
  assert.notEqual(forceBlock, -1);
  assert.notEqual(directPushPolicy, -1);
  assert.ok(forceBlock < directPushPolicy, 'force-push block should run before direct-push allowlist policy');
  assert.match(source, /Force push is never allowed, including for repos allowlisted for direct default-branch pushes/);
});

test('plugin schema no longer exposes a force-push bypass toggle', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(manifest.configSchema.properties, 'blockForcePush'), false);
});


test('plugin source blocks wrapped git pushes before repo preflight', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const wrappedBlock = source.indexOf('if (isWrappedGitPushCommand(command))');
  const repoPathRead = source.indexOf('const repoPath = extractRepoPath(command, event.params);');
  assert.notEqual(wrappedBlock, -1);
  assert.notEqual(repoPathRead, -1);
  assert.ok(wrappedBlock < repoPathRead, 'wrapped-push block should run before repo path preflight');
  assert.match(source, /Repo Guard blocked a wrapped git push/);
});
