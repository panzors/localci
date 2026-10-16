import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { paths, type QueuedRun } from './state.ts';

const exec = promisify(execFile);

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 << 20, windowsHide: true });
  return stdout;
}

/** One bare clone, fetched into, never re-cloned (FR-3.1). */
export async function ensureRepo(repo: string) {
  if (!fs.existsSync(paths.repo)) await git(['clone', '--bare', `https://github.com/${repo}.git`, paths.repo]);
}

/** ref name -> sha */
export function parseLsRemote(out: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split('\t');
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

export async function lsRemote() {
  return parseLsRemote(await git(['ls-remote', 'origin', 'refs/heads/*', 'refs/pull/*/head'], paths.repo));
}

/** Checks out run.sha in reusable worktree slot-N and cleans it, keeping node_modules. Returns the slot path. */
export async function prepareSlot(slot: number, run: QueuedRun): Promise<string> {
  const src = run.pr ? `refs/pull/${run.pr}/head` : `refs/heads/${run.ref}`;
  await git(['fetch', 'origin', `+${src}:refs/lci/${run.ref}`], paths.repo);
  const dir = paths.slot(slot);
  if (fs.existsSync(join(dir, '.git'))) {
    await git(['checkout', '--force', '--detach', run.sha], dir);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    await git(['worktree', 'prune'], paths.repo);
    await git(['worktree', 'add', '--force', '--detach', dir, run.sha], paths.repo);
  }
  await git(['clean', '-ffdx', '-e', 'node_modules'], dir);
  return dir;
}
