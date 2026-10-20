# LocalCI — Requirements

A local CLI that watches one GitHub repository, runs CI scripts and e2e tests on changed branches and pull requests, and reports failures. It runs on your own machine, so it does not use GitHub Actions minutes.

**Status key:** `[ ]` not started · `[~]` in progress · `[x]` done
Update the checkbox and the **Status** column as work lands. Reference requirement IDs (e.g. `FR-3.2`) in commit messages.

---

## 1. Goals

- Run CI and e2e for one repo without GitHub Actions.
- Use almost no GitHub API calls.
- Keep disk use bounded however many branches or PRs exist.
- Make failures easy to find and investigate.
- Let the user turn processing on and off.

### Non-goals (v1)

- Multiple repositories.
- CLI dashboard (for simplicity)
- Database (state lives in JSON files).
- Dockerised when possible
- Single threaded
- Auto fetch and test
- Some configurations are opt in

---

## 2. Tech constraints

| ID | Constraint |
|----|------------|
| TC-1 | Node.js 22+, TypeScript. No runtime dependencies unless a requirement cannot be met without one. |
| TC-2 | Must run on Windows 11 (primary). Linux/macOS should work but are not tested in v1. |
| TC-3 | Requires `git` and Docker on PATH. |
| TC-4 | GitHub auth via a fine-grained token with only **Commit statuses: write** and **Pull requests: read**, read from env var `LCI_GITHUB_TOKEN`. Never written to disk or logs. |

---

## 3. Functional requirements

### FR-1 Configuration

| ID | Requirement | Status |
|----|-------------|--------|
| FR-1.1 | [x] Read `lci.json` from the working directory (or `--config <path>`). | Done |
| FR-1.2 | [x] Config fields: `repo` (`owner/name`), `pollSeconds`, `concurrency`, `branches[]`, `pullRequests` (bool), `jobs[]`. | Done |
| FR-1.3 | [x] Each job has `name`, `run` (shell command), optional `locks[]`, optional `artifacts[]` (paths relative to the checkout), optional `timeoutMinutes`, optional `manual` (default false: left out of automatic runs, run only by `lci run <job> <ref>`). | Done |
| FR-1.4 | [x] Invalid config fails at startup with a message naming the bad field. | Done |

Example:

```json
{
  "repo": "owner/name",
  "pollSeconds": 60,
  "concurrency": 2,
  "branches": ["main", "develop"],
  "pullRequests": true,
  "jobs": [
    { "name": "ci",  "run": "npm ci && npm run lint && npm test" },
    { "name": "e2e", "run": "npm run e2e", "locks": ["shared-db"],
      "artifacts": ["playwright-report", "test-results"] }
  ]
}
```

### FR-2 Change detection (watcher)

| ID | Requirement | Status |
|----|-------------|--------|
| FR-2.1 | [x] Every `pollSeconds`, read branch and PR head SHAs with `git ls-remote origin 'refs/heads/*' 'refs/pull/*/head'` (git protocol, uses no API quota). | Done |
| FR-2.2 | [~] Find open PRs via `GET /repos/{repo}/pulls?state=open` with `If-None-Match` ETag. A `304` reply means no change and costs no API quota. | Not tried against live GitHub yet |
| FR-2.3 | [x] Track only the configured `branches` plus open PRs (when `pullRequests` is true). | Done |
| FR-2.4 | [x] When a tracked ref's SHA differs from the one in `state.json`, queue a run for that ref + SHA. | Done |
| FR-2.5 | [x] If a ref gets a new SHA while an older run for it is queued or running, cancel the older run (FR-4.5). | Done |
| FR-2.6 | [x] Closed or merged PRs are dropped from tracking and any queued run for them is removed. | Done |
| FR-2.7 | [x] GitHub API calls total ≤ 1 per poll plus 1 per job status update. | Done |

### FR-3 Workspace and disk usage

| ID | Requirement | Status |
|----|-------------|--------|
| FR-3.1 | [x] Keep one bare clone at `~/.lci/repo.git`. Fetch into it; never re-clone. | Done |
| FR-3.2 | [x] Keep `concurrency` reusable git worktrees at `~/.lci/work/slot-N`. Disk use is capped at N checkouts. | Done |
| FR-3.3 | [x] Before a run, check out the target SHA in a free slot (`--force`) and clean untracked files except `node_modules`. | Done |
| FR-3.4 | [x] Share one package cache across all slots (`npm ci --prefer-offline --cache ~/.lci/npm-cache`, or a pnpm store if the repo uses pnpm). | npm_config_cache / npm_config_store_dir env, covers npm and pnpm |
| FR-3.5 | [x] `lci clean` removes all slots and caches. Run history is kept unless `--runs` is passed. | Done |

### FR-4 Running jobs

| ID | Requirement | Status |
|----|-------------|--------|
| FR-4.1 | [x] A run executes its `jobs` in order in its slot and stops at the first failing job. | Done |
| FR-4.2 | [x] At most `concurrency` runs execute at once. | Done |
| FR-4.3 | [x] A job with `locks` waits until every named lock is free, holds them only for that job, then releases them, even on failure or cancellation. Other runs' unlocked jobs keep running. | Done |
| FR-4.4 | [x] Jobs exceeding `timeoutMinutes` are killed and marked failed. | Done |
| FR-4.5 | [x] Cancelling or killing a job kills its whole process tree (Windows: `taskkill /T /F`) so browsers and containers do not keep running and hold locks. | Done |
| FR-4.6 | [x] Each job's stdout and stderr are streamed to `.lci/<ref>-<sha7>/<job>.log`. | Done |
| FR-4.7 | [x] Env vars passed to jobs: `LCI_REF`, `LCI_SHA`, `LCI_PR` (if a PR), `LCI_RUN_DIR`. | Done |

### FR-5 Results, artifacts and flagging

| ID | Requirement | Status |
|----|-------------|--------|
| FR-5.1 | [x] Each run writes `.lci/<ref>-<sha7>/status.json`: ref, sha, PR number, start/end times, per-job result (`passed` / `failed` / `cancelled` / `skipped`), exit code. | Done |
| FR-5.2 | [x] When a job passes or fails, copy its `artifacts` paths into `.lci/<ref>-<sha7>/artifacts/<job>/` and zip them to `artifacts/<job>.zip`. | Done |
| FR-5.3 | [~] Post a GitHub commit status per job (`context: lci/<job>`): `pending` at start, then `success` / `failure` / `error`. The description holds the first error line (≤140 chars). | Not tried against live GitHub yet |
| FR-5.4 | [~] If GitHub is unreachable, the run still completes and is recorded locally. Status posting is retried on the next poll. | Outbox in state.json; not tried against live GitHub yet |
| FR-5.5 | [x] Keep the last N runs per ref (default 10) and delete older run folders. | Done |

### FR-6 CLI commands

| ID | Command | Behaviour | Status |
|----|---------|-----------|--------|
| FR-6.1 | `lci start` | [~] Runs the watcher and scheduler in the foreground. Ctrl-C stops it gracefully: running jobs are cancelled and their locks released. | Ctrl-C path not checked by hand yet |
| FR-6.2 | `lci pause` | [x] Sets `paused: true` in `state.json`. Running jobs finish; nothing new starts; polling continues so changes queue up. | Blocks new runs; an active run finishes all its jobs |
| FR-6.3 | `lci resume` | [x] Clears the paused flag; queued runs start. | Done |
| FR-6.4 | `lci status` | [x] Shows: paused/running, queue, active runs with slot and job, held locks, last poll time. | Done |
| FR-6.5 | `lci run <branch\|pr#>` | [x] Queues a run for the ref's current head, even if its SHA has not changed. | Done |
| FR-6.5a | `lci run <job> <branch\|pr#>` | [x] Queues a run of only that job at the front of the queue. New commits on the ref do not cancel or replace it. | Done |
| FR-6.6 | `lci runs [--failed] [--ref <ref>]` | [x] Lists run history, newest first, with the run folder path. | Done |
| FR-6.7 | `lci clean [--runs]` | [x] See FR-3.5. | Done |

---

## 4. Non-functional requirements

| ID | Requirement | Status |
|----|-------------|--------|
| NFR-1 | [x] The daemon recovers from a crash: on restart, runs that were in progress are marked `error` and re-queued. | Done |
| NFR-2 | [x] `state.json` is written atomically (write to a temp file, then rename) so a crash cannot corrupt it. | Done |
| NFR-3 | [x] The token never appears in logs, `status.json` or error output. | Done |
| NFR-4 | [x] Each piece of non-trivial logic (diffing SHAs, lock scheduling, config validation) has a unit test. | Done |

---

## 5. Milestones

| # | Milestone | Requirements | Status |
|---|-----------|--------------|--------|
| M1 | Manual run in a worktree with logs | FR-1, FR-3.1–3.4, FR-4.1, FR-4.6, FR-4.7, FR-5.1, FR-6.5 | [x] |
| M2 | Watcher + state | FR-2.1–2.4, FR-2.6, FR-6.1, NFR-2 | [~] |
| M3 | Concurrency + locks | FR-4.2–4.4, FR-6.4 | [x] |
| M4 | Flagging + artifacts | FR-5.2–5.5, FR-6.6, NFR-3 | [~] |
| M5 | Control + cancellation + recovery | FR-2.5, FR-4.5, FR-6.2, FR-6.3, FR-6.7, FR-3.5, NFR-1 | [x] |

Once M2 is done, remove the `pull_request` triggers from the target repo's GitHub workflows (or switch them to `workflow_dispatch`) so Actions minutes stop being used.

---

## 6. Open questions

- [x] Does the target repo use npm or pnpm? Both are handled: jobs get a shared npm cache and pnpm store via env vars.
- [ ] Should e2e run on draft PRs, or only once a PR is ready for review?
- [ ] Is a desktop notification on failure wanted, in addition to commit statuses?
