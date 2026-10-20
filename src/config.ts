import fs from 'node:fs';

export interface Job { name: string; run: string; locks: string[]; artifacts: string[]; timeoutMinutes?: number; manual: boolean }
export interface Config {
  repo: string;
  pollSeconds: number;
  concurrency: number;
  branches: string[];
  pullRequests: boolean;
  keepRuns: number;
  jobs: Job[];
}

const TOP_KEYS = ['repo', 'pollSeconds', 'concurrency', 'branches', 'pullRequests', 'keepRuns', 'jobs'];
const JOB_KEYS = ['name', 'run', 'locks', 'artifacts', 'timeoutMinutes', 'manual'];

function bad(field: string, msg: string): never {
  throw new Error(`Invalid config: "${field}" ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function posInt(v: unknown, field: string, def?: number): number {
  if (v === undefined && def !== undefined) return def;
  if (!Number.isInteger(v) || (v as number) < 1) bad(field, 'must be a positive integer');
  return v as number;
}

function strings(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) bad(field, 'must be an array of non-empty strings');
  return v;
}

function noUnknown(o: Record<string, unknown>, allowed: string[], prefix: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(prefix + k, 'is not a known field');
}

export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) bad('(root)', 'must be a JSON object');
  noUnknown(raw, TOP_KEYS, '');
  const { repo, pullRequests, jobs } = raw;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) bad('repo', 'must be "owner/name"');
  if (pullRequests !== undefined && typeof pullRequests !== 'boolean') bad('pullRequests', 'must be true or false');
  if (!Array.isArray(jobs) || !jobs.length) bad('jobs', 'must be a non-empty array');

  const names = new Set<string>();
  const parsedJobs = jobs.map((j: unknown, i): Job => {
    const f = `jobs[${i}]`;
    if (!isObject(j)) bad(f, 'must be an object');
    noUnknown(j, JOB_KEYS, `${f}.`);
    // Job names become log file names and GitHub status contexts.
    if (typeof j.name !== 'string' || !/^[\w.-]+$/.test(j.name)) bad(`${f}.name`, 'must use only letters, digits, ".", "_" or "-"');
    if (names.has(j.name)) bad(`${f}.name`, `duplicates "${j.name}"`);
    names.add(j.name);
    if (typeof j.run !== 'string' || !j.run.trim()) bad(`${f}.run`, 'must be a non-empty command');
    if (j.manual !== undefined && typeof j.manual !== 'boolean') bad(`${f}.manual`, 'must be true or false');
    return {
      name: j.name,
      run: j.run,
      locks: strings(j.locks, `${f}.locks`),
      artifacts: strings(j.artifacts, `${f}.artifacts`),
      timeoutMinutes: j.timeoutMinutes === undefined ? undefined : posInt(j.timeoutMinutes, `${f}.timeoutMinutes`),
      manual: j.manual ?? false,
    };
  });

  return {
    repo,
    pollSeconds: posInt(raw.pollSeconds, 'pollSeconds', 60),
    concurrency: posInt(raw.concurrency, 'concurrency', 1),
    branches: strings(raw.branches, 'branches'),
    pullRequests: pullRequests ?? false,
    keepRuns: posInt(raw.keepRuns, 'keepRuns', 10),
    jobs: parsedJobs,
  };
}

export function loadConfig(file = 'lci.json'): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read config file ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid config: ${file} is not valid JSON (${(e as Error).message})`);
  }
  return validateConfig(raw);
}
