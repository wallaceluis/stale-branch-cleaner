# Stale Branch Cleaner

A GitHub Action that deletes branches with no recent commits and no open pull request.

It is **safe by default**: it runs in dry-run mode until you turn it off, never touches the default branch or protected branches, and caps how many branches it deletes per run.

## Usage

```yaml
name: Cleanup stale branches

on:
  schedule:
    - cron: "0 6 * * 1" # every Monday at 06:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: read

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: wallaceluis/stale-branch-cleaner@v1
        with:
          days-inactive: 60
          dry-run: false
```

Start with `dry-run: true` (the default), check the job summary to see what would be removed, then switch it to `false`.

More complete workflows are in [`examples/`](examples):

- [`cleanup-branches.yml`](examples/cleanup-branches.yml): weekly cleanup with a manual dry-run toggle
- [`dry-run-report.yml`](examples/dry-run-report.yml): report only, with read-only permissions

## Which branches are deleted?

A branch is deleted only when **all** of the following are true:

1. Its last commit is at least `days-inactive` days old.
2. It is not the head of an open pull request.
3. It is not the base (target) of an open pull request.
4. It is not the repository's default branch.
5. It is not covered by a branch protection rule or ruleset.
6. It does not match any pattern in `protected-branches`.

Stale branches are processed from the oldest to the newest, up to `max-deletions` per run.

## Inputs

| Input                | Default                         | Description                                                                 |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `github-token`       | `${{ github.token }}`           | Token used to call the GitHub API                                           |
| `days-inactive`      | `90`                            | Days without commits after which a branch is considered stale               |
| `protected-branches` | `main,master,develop,release/*` | Comma or newline separated names or glob patterns that are never deleted    |
| `dry-run`            | `true`                          | When `true`, only reports what would be deleted                             |
| `max-deletions`      | `50`                            | Maximum number of branches deleted in a single run                          |

In `protected-branches`, `*` matches any sequence of characters, including `/`. So `release/*` matches `release/1.0` and `release/1.0/hotfix`.

## Outputs

| Output             | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `stale-branches`   | JSON array with the stale branches selected in this run        |
| `deleted-branches` | JSON array with the branches that were actually deleted        |
| `deleted-count`    | Number of branches deleted                                     |

```yaml
- uses: wallaceluis/stale-branch-cleaner@v1
  id: cleanup
  with:
    dry-run: false

- if: steps.cleanup.outputs.deleted-count != '0'
  run: echo 'Deleted ${{ steps.cleanup.outputs.deleted-branches }}'
```

The action also writes a table with the affected branches to the job summary.

## Permissions

| Permission             | Why                                             |
| ---------------------- | ----------------------------------------------- |
| `contents: write`      | Delete branches (`read` is enough for dry-run)  |
| `pull-requests: read`  | Check whether a branch has an open pull request |

The default `GITHUB_TOKEN` is enough. Deleting a branch with that token does not trigger other workflows.

## How it works

- Branches, last commit dates and open pull request counts come from a single paginated GraphQL query (100 branches per request), so large repositories do not burn the API rate limit.
- Protected branches come from the REST API, whose `protected` flag also reflects rulesets.
- Deletions go through `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`. A branch that is already gone is ignored; any other failure is reported and fails the job at the end, after the remaining branches were processed.

Deleting a branch does not delete its commits immediately. If you remove one by mistake, you can restore it from the SHA shown in the repository's activity view (`https://github.com/<owner>/<repo>/activity`).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # bundles src/ into dist/ with ncc
```

`dist/` is committed because GitHub runs the action straight from the repository. Rebuild and commit it whenever `src/` changes.

| File             | Responsibility                                               |
| ---------------- | ------------------------------------------------------------ |
| `src/main.ts`    | Reads inputs, orchestrates the run, sets outputs and summary |
| `src/github.ts`  | GitHub API calls (GraphQL + REST)                            |
| `src/cleanup.ts` | Pure logic that decides which branches are stale             |

### Releasing

```bash
npm run all
git commit -am "build: compile action runner"
git tag -a v1.0.0 -m "v1.0.0"
git tag -fa v1 -m "v1"
git push origin main v1.0.0
git push origin v1 --force   # move the major tag
```

## License

[MIT](LICENSE)
