import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import type { Config, Job } from './config.ts';
import { prepareSlot } from './git.ts';
import type { Locks } from './locks.ts';
import { writeRunStatus, type JobResult, type JobStatus, type RunStatus } from './runs.ts';
import { paths, runDir, type GhState, type QueuedRun } from './state.ts';

export interface RunContext {
  locks: Locks;
  signal: AbortSignal;
  onJob?: (job: string) => void;
  report?: (sha: string, context: string, state: GhState, description: string) => void;
}

type Outcome = Pick<JobStatus, 'result' | 'exitCode' | 'description'>;

const GH: Partial<Record<JobResult, GhState>> = { passed: 'success', failed: 'failure', cancelled: 'error', error: 'error' };
const now = () => new Date().toISOString();

/** Runs the run's jobs in order in a slot, stopping at the first failure (FR-4.1). Never throws for job failures. */
export async function executeRun(cfg: Config, run: QueuedRun, slot: number, ctx: RunContext): Promise<RunStatus> {
  const jobs = cfg.jobs.filter(j => (run.manual ? j.name === run.manual : !j.manual));
  const dir = runDir(run);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const status: RunStatus = {
    ref: run.ref, sha: run.sha, pr: run.pr, startedAt: now(), result: 'running',
    jobs: jobs.map(j => ({ name: j.name, result: 'skipped', exitCode: null })),
  };
  const save = () => writeRunStatus(dir, status);
  save();

  let cwd: string;
  try {
    cwd = await prepareSlot(slot, run);
  } catch (e) {
    Object.assign(status, { result: 'error', error: (e as Error).message, endedAt: now() });
    save();
    return status;
  }

  for (const [i, job] of jobs.entries()) {
    if (ctx.signal.aborted) status.result = 'cancelled';
    if (status.result !== 'running') break;
    const js = status.jobs[i];
    Object.assign(js, { result: 'running', startedAt: now() });
    save();
    ctx.onJob?.(job.name);
    ctx.report?.(run.sha, `lci/${job.name}`, 'pending', 'running');

    Object.assign(js, await runJob(job, run, cwd, dir, ctx), { endedAt: now() });
    if (js.result !== 'passed') status.result = js.result;
    if (js.result === 'passed' || js.result === 'failed') copyArtifacts(job, cwd, dir);
    ctx.report?.(run.sha, `lci/${job.name}`, GH[js.result]!, js.description ?? js.result);
    save();
  }
  if (status.result === 'running') status.result = 'passed';
  status.endedAt = now();
  save();
  return status;
}

async function runJob(job: Job, run: QueuedRun, cwd: string, dir: string, ctx: RunContext): Promise<Outcome> {
  let release = () => {};
  if (job.locks.length) {
    try {
      release = await ctx.locks.acquire(job.locks, run.ref, ctx.signal);
    } catch {
      return { result: 'cancelled', exitCode: null, description: 'cancelled while waiting for locks' };
    }
  }
  try {
    return await spawnJob(job, run, cwd, dir, ctx.signal);
  } finally {
    release();
  }
}

function spawnJob(job: Job, run: QueuedRun, cwd: string, dir: string, signal: AbortSignal): Promise<Outcome> {
  if (signal.aborted) return Promise.resolve({ result: 'cancelled', exitCode: null, description: 'cancelled' });
  return new Promise(resolve => {
    const log = fs.createWriteStream(join(dir, `${job.name}.log`));
    log.write(`$ ${job.run}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LCI_REF: run.ref,
      LCI_SHA: run.sha,
      LCI_RUN_DIR: dir,
      // One package cache for every slot (FR-3.4); npm and pnpm both read npm_config_*.
      npm_config_cache: paths.npmCache,
      npm_config_prefer_offline: 'true',
      npm_config_store_dir: paths.pnpmStore,
    };
    // Jobs run branch and PR code; never hand them the token.
    delete env.LCI_GITHUB_TOKEN;
    if (run.pr) env.LCI_PR = String(run.pr);

    const child = spawn(job.run, {
      cwd, env, shell: true, windowsHide: true,
      detached: process.platform !== 'win32', // own process group, so killTree can kill it on POSIX
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let firstError: string | undefined;
    let lastLine: string | undefined;
    // shortcut: scans per chunk, so a line split across chunks may be missed; fine for a 140-char summary.
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      for (const line of chunk.toString().split(/\r?\n/)) {
        const l = line.trim();
        if (!l) continue;
        lastLine = l;
        if (!firstError && /\berror\b|\bfail/i.test(l)) firstError = l;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let killedBy: 'cancel' | 'timeout' | undefined;
    const kill = (why: 'cancel' | 'timeout') => {
      if (killedBy) return;
      killedBy = why;
      if (child.pid) killTree(child.pid);
    };
    const onAbort = () => kill('cancel');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = job.timeoutMinutes ? setTimeout(() => kill('timeout'), job.timeoutMinutes * 60_000) : undefined;

    const finish = (o: Outcome) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      log.end(() => resolve(o));
    };
    child.on('error', e => finish({ result: 'failed', exitCode: null, description: e.message }));
    child.on('close', code => {
      if (killedBy === 'cancel') finish({ result: 'cancelled', exitCode: code, description: 'cancelled' });
      else if (killedBy === 'timeout') finish({ result: 'failed', exitCode: code, description: `timed out after ${job.timeoutMinutes} min` });
      else if (code === 0) finish({ result: 'passed', exitCode: 0, description: 'passed' });
      else finish({ result: 'failed', exitCode: code, description: (firstError ?? lastLine ?? `exit code ${code}`).slice(0, 140) });
    });
  });
}

/** Kills the whole process tree so browsers and containers do not outlive the job (FR-4.5). */
export function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Copies the job's artifacts to artifacts/<job>/ and zips them to artifacts/<job>.zip (FR-5.2). */
function copyArtifacts(job: Job, cwd: string, dir: string) {
  const out = join(dir, 'artifacts', job.name);
  for (const p of job.artifacts) {
    const src = join(cwd, p);
    if (fs.existsSync(src)) fs.cpSync(src, join(out, p), { recursive: true });
  }
  if (!fs.existsSync(out)) return;
  // shortcut: relies on bsdtar (Windows 10+, macOS) for -a zip; GNU tar on Linux writes a plain tar. Add a zip lib if Linux matters.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, ['-a', '-cf', `${out}.zip`, '-C', out, '.'], { windowsHide: true });
  if (r.status !== 0) fs.appendFileSync(join(dir, `${job.name}.log`), `\n[lci] zipping artifacts failed: ${r.error?.message ?? r.stderr}\n`);
}
