import fs from 'node:fs';
import { join } from 'node:path';
import { paths, writeJsonAtomic } from './state.ts';

export type JobResult = 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped' | 'error';
export interface JobStatus {
  name: string;
  result: JobResult;
  exitCode: number | null;
  startedAt?: string;
  endedAt?: string;
  description?: string;
}
export interface RunStatus {
  ref: string;
  sha: string;
  pr?: number;
  startedAt: string;
  endedAt?: string;
  result: JobResult;
  error?: string;
  jobs: JobStatus[];
}

export const writeRunStatus = (dir: string, s: RunStatus) => writeJsonAtomic(join(dir, 'status.json'), s);

/** All recorded runs, newest first. */
export function readRuns(): (RunStatus & { dir: string })[] {
  if (!fs.existsSync(paths.runs)) return [];
  return fs.readdirSync(paths.runs)
    .flatMap(name => {
      const dir = join(paths.runs, name);
      try {
        return [{ ...(JSON.parse(fs.readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus), dir }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Keeps the newest `keep` runs per ref (FR-5.5). */
export function pruneRuns(keep: number) {
  const seen = new Map<string, number>();
  for (const r of readRuns()) {
    const n = (seen.get(r.ref) ?? 0) + 1;
    seen.set(r.ref, n);
    if (n > keep) fs.rmSync(r.dir, { recursive: true, force: true });
  }
}

/** Marks a run interrupted by a crash as error (NFR-1). */
export function markCrashed(dir: string) {
  try {
    const s = JSON.parse(fs.readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus;
    s.result = 'error';
    s.error = 'lci stopped unexpectedly during this run';
    s.endedAt = new Date().toISOString();
    for (const j of s.jobs) if (j.result === 'running') j.result = 'error';
    writeRunStatus(dir, s);
  } catch {
    // run never got as far as writing status.json
  }
}
