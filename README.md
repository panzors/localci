# LocalCI

A local CLI that watches one GitHub repo's branches and pull requests, runs CI and e2e jobs on your own machine, and reports results back as GitHub commit statuses. It uses no GitHub Actions minutes.

See [REQUIREMENTS.md](REQUIREMENTS.md) for scope and progress.

## Setup

Requires Node.js 22.18+ (runs the TypeScript directly, no build step), `git` and Docker on PATH.

```sh
npm install        # dev tooling only: typescript for `npm run typecheck`
npm link           # puts `lci` on PATH
export LCI_GITHUB_TOKEN=...   # fine-grained: Commit statuses (write), Pull requests (read)
```

Create `lci.json` in the directory you run `lci` from (see the example in REQUIREMENTS.md, FR-1). Optional fields and defaults: `pollSeconds` 60, `concurrency` 1, `branches` [], `pullRequests` false, `keepRuns` 10.

`git` must already be able to fetch the repo (e.g. via Git Credential Manager for private repos). The token is only used for the GitHub API and is never passed to jobs.

## Commands

| Command | What it does |
|---------|--------------|
| `lci start` | Watch and run in the foreground; Ctrl-C cancels running jobs and re-queues them. |
| `lci pause` / `lci resume` | Stop / restart starting new runs. Polling continues. |
| `lci status` | Daemon state, queue, active runs, held locks, last poll. |
| `lci run <branch\|pr#>` | Queue the ref's current head (`lci run 42` for PR #42). |
| `lci run <job> <branch\|pr#>` | Run just that job on the ref's head, ahead of everything queued (`lci run e2e #42`). Jobs with `"manual": true` only run this way. |
| `lci runs [--failed] [--ref <ref>]` | Run history with folder paths. |
| `lci clean [--runs]` | Remove worktree slots and caches (and run history). Stop `lci start` first. |

Run results go to `.lci/<ref>-<sha7>/` (`status.json`, `<job>.log`, `artifacts/`) next to `lci.json`; add `.lci/` to that repo's `.gitignore`. Everything else lives in `~/.lci` (override with `LCI_HOME`): `repo.git`, `work/slot-N`, `npm-cache` and `state.json`.

Jobs run whatever code is on the branch or PR, on your machine. Only enable `pullRequests` for repos where you trust everyone who can open a PR.

## Development

```sh
npm test           # node --test
npm run typecheck
```
