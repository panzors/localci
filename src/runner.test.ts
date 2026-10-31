import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Real git + real processes against a throwaway LCI_HOME and a local "remote".
const root = fs.mkdtempSync(join(tmpdir(), 'lci-'));
process.env.LCI_HOME = join(root, 'home');
const src = join(root, 'src');
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: src }).toString().trim();
fs.mkdirSync(src);
git('init', '-q', '-b', 'main');
fs.writeFileSync(join(src, 'a.txt'), 'a');
git('add', '.');
git('commit', '-qm', 'init');
const sha = git('rev-parse', 'HEAD');

const { paths } = await import('./state.ts');
const { executeRun } = await import('./runner.ts');
const { Locks } = await import('./locks.ts');
const { validateConfig } = await import('./config.ts');
execFileSync('git', ['clone', '-q', '--bare', src, paths.repo]);

const node = (code: string) => `node -e "${code}"`;
const run = { ref: 'main', sha };
const ctx = () => ({ locks: new Locks(), signal: new AbortController().signal });

test('runs jobs in order, stops at first failure, keeps logs, env and artifacts', async () => {
  const cfg = validateConfig({
    repo: 'o/r',
    jobs: [
      { name: 'ok', run: node("console.log(process.env.LCI_REF, process.env.LCI_SHA, !!process.env.LCI_GITHUB_TOKEN);require('fs').mkdirSync('rep');require('fs').writeFileSync('rep/index.html','x')"), artifacts: ['rep'] },
      { name: 'bad', run: node("require('fs').writeFileSync('out.txt','x');console.error('first error');console.error('npm warn this will error');console.error('boom error');console.error('npm warn later error');process.exit(3)"), artifacts: ['out.txt', 'missing'] },
      { name: 'never', run: node('') },
    ],
  });
  process.env.LCI_GITHUB_TOKEN = 'secret';
  const st = await executeRun(cfg, run, 0, ctx());
  delete process.env.LCI_GITHUB_TOKEN;

  assert.equal(st.result, 'failed');
  assert.deepEqual(st.jobs.map(j => [j.result, j.exitCode]), [['passed', 0], ['failed', 3], ['skipped', null]]);
  assert.equal(st.jobs[1].description, 'boom error');
  const dir = join(paths.runs, `main-${sha.slice(0, 7)}`);
  assert.match(fs.readFileSync(join(dir, 'ok.log'), 'utf8'), new RegExp(`main ${sha} false`));
  assert.ok(fs.existsSync(join(dir, 'artifacts', 'bad', 'out.txt')));
  assert.ok(fs.existsSync(join(dir, 'artifacts', 'ok', 'rep', 'index.html')), 'passed jobs keep artifacts too');
  assert.ok(fs.statSync(join(dir, 'artifacts', 'ok.zip')).size > 0);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'status.json'), 'utf8')).result, 'failed');
  assert.ok(fs.existsSync(join(paths.slot(0), 'a.txt')));
});

test('reuses the slot and cleans untracked files except node_modules', async () => {
  fs.writeFileSync(join(paths.slot(0), 'junk.txt'), 'x');
  fs.mkdirSync(join(paths.slot(0), 'node_modules'), { recursive: true });
  const cfg = validateConfig({ repo: 'o/r', jobs: [{ name: 'ok', run: node('') }] });
  assert.equal((await executeRun(cfg, run, 0, ctx())).result, 'passed');
  assert.ok(!fs.existsSync(join(paths.slot(0), 'junk.txt')));
  assert.ok(fs.existsSync(join(paths.slot(0), 'node_modules')));
});

test('timeout kills the job and marks it failed', async () => {
  const cfg = validateConfig({ repo: 'o/r', jobs: [{ name: 'slow', run: node('setTimeout(()=>{},60000)') }] });
  cfg.jobs[0].timeoutMinutes = 0.02;
  const st = await executeRun(cfg, run, 0, ctx());
  assert.equal(st.jobs[0].result, 'failed');
  assert.match(st.jobs[0].description!, /timed out/);
});

test('cancel kills the job and releases its locks', async () => {
  const cfg = validateConfig({ repo: 'o/r', jobs: [{ name: 'slow', run: node('setTimeout(()=>{},60000)'), locks: ['db'] }, { name: 'next', run: node('') }] });
  const ctrl = new AbortController();
  const locks = new Locks();
  const pending = executeRun(cfg, run, 0, { locks, signal: ctrl.signal, onJob: () => setTimeout(() => ctrl.abort(), 500) });
  const st = await pending;
  assert.equal(st.result, 'cancelled');
  assert.deepEqual(st.jobs.map(j => j.result), ['cancelled', 'skipped']);
  assert.equal(locks.held.size, 0);
});

test('automatic runs skip manual jobs; a manual run executes only its job', async () => {
  const cfg = validateConfig({ repo: 'o/r', jobs: [{ name: 'ci', run: node('') }, { name: 'e2e', run: node(''), manual: true }] });
  assert.deepEqual((await executeRun(cfg, run, 0, ctx())).jobs.map(j => j.name), ['ci']);
  const st = await executeRun(cfg, { ...run, manual: 'e2e' }, 0, ctx());
  assert.deepEqual(st.jobs.map(j => [j.name, j.result]), [['e2e', 'passed']]);
  assert.ok(fs.existsSync(join(paths.runs, `main-${sha.slice(0, 7)}-e2e`, 'e2e.log')));
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
