import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { start } from './daemon.ts';
import { ensureRepo, git, lsRemote } from './git.ts';
import { readRuns } from './runs.ts';
import { isAlive, mutateState, paths, readState, redact } from './state.ts';

const USAGE = `Usage: lci <command> [--config <path>]

  start                          watch the repo and run jobs (Ctrl-C to stop)
  pause | resume                 stop / restart starting new runs
  status                         show queue, active runs and locks
  run <branch|pr#>               queue a run for the ref's current head
  runs [--failed] [--ref <ref>]  list run history, newest first
  clean [--runs]                 remove worktree slots and caches (and run history)`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      failed: { type: 'boolean' },
      ref: { type: 'string' },
      runs: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;

  switch (cmd) {
    case 'start':
      return start(loadConfig(values.config));

    case 'pause':
    case 'resume':
      mutateState(s => { s.paused = cmd === 'pause'; });
      return console.log(cmd === 'pause' ? 'Paused: running jobs finish, nothing new starts.' : 'Resumed.');

    case 'status': {
      const s = readState();
      const daemon = isAlive(s.daemonPid) ? `running (pid ${s.daemonPid})` : 'not running';
      console.log(`daemon:    ${daemon}${s.paused ? ', PAUSED' : ''}`);
      console.log(`last poll: ${s.lastPoll ?? 'never'}`);
      console.log(`queue:     ${s.queue.map(q => `${q.ref}@${q.sha.slice(0, 7)}`).join(', ') || '(empty)'}`);
      console.log('active:');
      for (const a of s.active) console.log(`  slot-${a.slot}  ${a.ref}@${a.sha.slice(0, 7)}  ${a.job ?? '(checking out)'}`);
      if (!s.active.length) console.log('  (none)');
      const locks = Object.entries(s.locks);
      console.log(`locks:     ${locks.map(([l, ref]) => `${l} -> ${ref}`).join(', ') || '(none held)'}`);
      if (s.outbox.length) console.log(`statuses waiting to post: ${s.outbox.length}`);
      return;
    }

    case 'run': {
      if (!arg) throw new Error('Usage: lci run <branch|pr#>');
      const cfg = loadConfig(values.config);
      await ensureRepo(cfg.repo);
      const remote = await lsRemote();
      const prNum = /^(?:#|pr-)?(\d+)$/.exec(arg)?.[1];
      const run = prNum
        ? { ref: `pr-${prNum}`, sha: remote.get(`refs/pull/${prNum}/head`) ?? '', pr: Number(prNum) }
        : { ref: arg, sha: remote.get(`refs/heads/${arg}`) ?? '' };
      if (!run.sha) throw new Error(`No ${prNum ? `pull request #${prNum}` : `branch "${arg}"`} on the remote`);
      mutateState(s => { s.queue = [...s.queue.filter(q => q.ref !== run.ref), run]; });
      console.log(`Queued ${run.ref}@${run.sha.slice(0, 7)}.`);
      if (!isAlive(readState().daemonPid)) console.log('lci is not running; start it with `lci start`.');
      return;
    }

    case 'runs': {
      const runs = readRuns().filter(r => (!values.failed || r.result === 'failed' || r.result === 'error') && (!values.ref || r.ref === values.ref));
      for (const r of runs) {
        const failedJob = r.jobs.find(j => j.result === 'failed' || j.result === 'error');
        console.log(`${r.startedAt}  ${r.result.padEnd(9)} ${`${r.ref}@${r.sha.slice(0, 7)}`.padEnd(28)} ${r.dir}`);
        if (failedJob) console.log(`    ${failedJob.name}: ${failedJob.description ?? r.error ?? ''}`);
        else if (r.error) console.log(`    ${r.error}`);
      }
      if (!runs.length) console.log('No runs.');
      return;
    }

    case 'clean': {
      if (isAlive(readState().daemonPid)) throw new Error('Stop `lci start` before cleaning.');
      for (const dir of [paths.work, paths.npmCache, paths.pnpmStore, ...(values.runs ? [paths.runs] : [])]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (fs.existsSync(paths.repo)) await git(['worktree', 'prune'], paths.repo);
      mutateState(s => { s.active = []; s.locks = {}; });
      return console.log(`Removed worktree slots and caches${values.runs ? ' and run history' : ''}.`);
    }

    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e: Error) => {
  console.error(redact(e.message));
  process.exit(1);
});
