import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOME = process.env.LCI_HOME ?? join(homedir(), '.lci');
export const paths = {
  repo: join(HOME, 'repo.git'),
  work: join(HOME, 'work'),
  slot: (n: number) => join(HOME, 'work', `slot-${n}`),
  npmCache: join(HOME, 'npm-cache'),
  pnpmStore: join(HOME, 'pnpm-store'),
  runs: join(HOME, 'runs'),
  state: join(HOME, 'state.json'),
};

export type GhState = 'pending' | 'success' | 'failure' | 'error';
/** `manual` names the one job a `lci run <job> <ref>` run executes; automatic runs leave it unset. */
export interface QueuedRun { ref: string; sha: string; pr?: number; manual?: string }
export const sameRun = (a: QueuedRun, b: QueuedRun) => a.ref === b.ref && a.manual === b.manual;
export interface ActiveRun extends QueuedRun { slot: number; dir: string; job?: string }
export interface StatusPost { sha: string; context: string; state: GhState; description: string }

export interface State {
  paused: boolean;
  daemonPid?: number;
  lastPoll?: string;
  seen: Record<string, string>;
  openPrs: number[];
  prEtag?: string;
  queue: QueuedRun[];
  active: ActiveRun[];
  locks: Record<string, string>;
  outbox: StatusPost[];
}

const empty = (): State => ({ paused: false, seen: {}, openPrs: [], queue: [], active: [], locks: {}, outbox: [] });

export function readState(): State {
  try {
    return { ...empty(), ...JSON.parse(retry(() => fs.readFileSync(paths.state, 'utf8'))) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw e;
  }
}

/** Read-modify-write of state.json. Synchronous, so the window between read and rename is tiny. */
export function mutateState<T>(fn: (s: State) => T): T {
  const s = readState();
  const result = fn(s);
  writeJsonAtomic(paths.state, s);
  return result;
}

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  retry(() => fs.renameSync(tmp, file));
}

function retry<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      // Windows briefly locks a file while another process reads or renames it.
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function isAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const runDir = (r: QueuedRun) => join(paths.runs, `${r.ref.replace(/[^\w.-]/g, '_')}-${r.sha.slice(0, 7)}${r.manual ? `-${r.manual}` : ''}`);

export function log(msg: string) {
  console.log(`${new Date().toISOString()} ${redact(msg)}`);
}

export function redact(s: string) {
  const t = process.env.LCI_GITHUB_TOKEN;
  return t ? s.split(t).join('***') : s;
}
