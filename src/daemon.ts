import type { Config } from './config.ts';
import { ensureRepo, lsRemote } from './git.ts';
import { openPullRequests, postStatus } from './github.ts';
import { Locks } from './locks.ts';
import { executeRun } from './runner.ts';
import { markCrashed, pruneRuns } from './runs.ts';
import { isAlive, log, mutateState, readState, runDir, type GhState, type QueuedRun } from './state.ts';
import { applyPoll, trackedRefs } from './watcher.ts';

/** `lci start`: watcher + scheduler in the foreground until Ctrl-C (FR-6.1). */
export async function start(cfg: Config) {
  const crashed = mutateState(s => {
    if (s.daemonPid !== process.pid && isAlive(s.daemonPid)) throw new Error(`lci is already running (pid ${s.daemonPid})`);
    s.daemonPid = process.pid;
    // NFR-1: runs left active by a crash are marked error and re-queued.
    const active = s.active;
    for (const a of active) {
      markCrashed(a.dir);
      if (!s.queue.some(q => q.ref === a.ref)) s.queue.unshift({ ref: a.ref, sha: a.sha, pr: a.pr });
    }
    s.active = [];
    s.locks = {};
    return active.length;
  });
  if (crashed) log(`re-queued ${crashed} run(s) interrupted by a previous crash`);

  const token = !!process.env.LCI_GITHUB_TOKEN;
  if (!token) log('LCI_GITHUB_TOKEN is not set: commit statuses will not be posted');
  await ensureRepo(cfg.repo);

  const locks = new Locks(held => mutateState(s => { s.locks = held; }));
  const running = new Map<number, { run: QueuedRun; ctrl: AbortController; done: Promise<void> }>();
  let stopping = false;

  const report = (sha: string, context: string, state: GhState, description: string) => {
    if (!token) return;
    mutateState(s => {
      s.outbox = s.outbox.filter(o => !(o.sha === sha && o.context === context));
      s.outbox.push({ sha, context, state, description });
    });
    void flush();
  };

  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (let item = readState().outbox[0]; item; item = readState().outbox[0]) {
        const code = await postStatus(cfg.repo, item);
        if (code >= 500 || code === 429) throw new Error(`GitHub returned ${code}`);
        if (code >= 400) log(`dropping status ${item.context} for ${item.sha.slice(0, 7)}: GitHub returned ${code}`);
        const posted = item;
        mutateState(s => {
          // A newer status for the same context may have replaced it meanwhile; keep that one.
          const i = s.outbox.findIndex(o => o.sha === posted.sha && o.context === posted.context && o.state === posted.state);
          if (i >= 0) s.outbox.splice(i, 1);
        });
      }
    } catch (e) {
      // FR-5.4: keep the outbox and retry on the next poll.
      log(`posting commit status failed, will retry: ${(e as Error).message}`);
    } finally {
      flushing = false;
    }
  }

  function schedule() {
    if (stopping || readState().paused) return;
    for (let slot = 0; slot < cfg.concurrency; slot++) {
      if (running.has(slot)) continue;
      const run = mutateState(s => {
        const r = s.queue.shift();
        if (r) s.active.push({ ...r, slot, dir: runDir(r) });
        return r;
      });
      if (!run) return;
      launch(run, slot);
    }
  }

  function launch(run: QueuedRun, slot: number) {
    const ctrl = new AbortController();
    const name = `${run.ref}@${run.sha.slice(0, 7)}`;
    log(`start ${name} in slot-${slot}`);
    const onJob = (job: string) => mutateState(s => {
      const a = s.active.find(x => x.slot === slot);
      if (a) a.job = job;
    });
    const done = executeRun(cfg, run, slot, { locks, signal: ctrl.signal, onJob, report })
      .then(st => log(`${st.result} ${name}${st.error ? `: ${st.error}` : ''} -> ${runDir(run)}`))
      .catch(e => log(`run ${name} crashed: ${(e as Error).message}`))
      .finally(() => {
        running.delete(slot);
        mutateState(s => {
          s.active = s.active.filter(a => a.slot !== slot);
          // Ctrl-C: run it again on the next start.
          if (stopping && !s.queue.some(q => q.ref === run.ref)) s.queue.unshift(run);
        });
        pruneRuns(cfg.keepRuns);
        schedule();
      });
    running.set(slot, { run, ctrl, done });
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const remote = await lsRemote();
      let prs: { prs: number[]; etag?: string } | null = null;
      if (cfg.pullRequests) {
        try {
          prs = await openPullRequests(cfg.repo, readState().prEtag);
        } catch (e) {
          log(`listing pull requests failed: ${(e as Error).message}`);
        }
      }
      const stale = mutateState(s => {
        if (prs) [s.openPrs, s.prEtag] = [prs.prs, prs.etag];
        s.lastPoll = new Date().toISOString();
        return applyPoll(s, trackedRefs(remote, cfg.branches, cfg.pullRequests ? s.openPrs : []));
      });
      for (const r of running.values()) {
        if (stale.includes(r.run.ref)) {
          log(`cancel ${r.run.ref}@${r.run.sha.slice(0, 7)}: newer commit pushed`);
          r.ctrl.abort();
        }
      }
    } catch (e) {
      log(`poll failed: ${(e as Error).message}`);
    } finally {
      polling = false;
    }
    await flush();
    schedule();
  }

  const timers = [setInterval(schedule, 2000), setInterval(poll, cfg.pollSeconds * 1000)];
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    log(`stopping: cancelling ${running.size} running run(s)`);
    for (const r of running.values()) r.ctrl.abort();
    await Promise.all([...running.values()].map(r => r.done));
    mutateState(s => { s.daemonPid = undefined; });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`watching ${cfg.repo} every ${cfg.pollSeconds}s with ${cfg.concurrency} slot(s)`);
  await poll();
}
