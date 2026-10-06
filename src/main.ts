import * as core from "@actions/core";
import * as github from "@actions/github";
import { type StaleBranch, classifyBranches, parseList } from "./cleanup.js";
import { deleteBranch, loadRepository } from "./github.js";

function positiveInt(name: string): number {
  const raw = core.getInput(name, { required: true });
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Input "${name}" must be a positive integer, got "${raw}".`);
  }
  return value;
}

async function writeSummary(title: string, branches: StaleBranch[], failed: string[]): Promise<void> {
  core.summary.addHeading(title, 2);
  if (branches.length > 0) {
    core.summary.addTable([
      [
        { data: "Branch", header: true },
        { data: "Last commit", header: true },
        { data: "Days inactive", header: true },
      ],
      ...branches.map((branch) => [
        branch.name,
        branch.lastCommitDate.toISOString().slice(0, 10),
        String(branch.daysInactive),
      ]),
    ]);
  } else {
    core.summary.addRaw("No stale branches found.", true);
  }
  if (failed.length > 0) {
    core.summary.addRaw(`Could not delete: ${failed.join(", ")}`, true);
  }
  await core.summary.write();
}

async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const daysInactive = positiveInt("days-inactive");
  const maxDeletions = positiveInt("max-deletions");
  const protectedPatterns = parseList(core.getInput("protected-branches"));
  const dryRun = core.getBooleanInput("dry-run");

  const octokit = github.getOctokit(token);
  const repo = github.context.repo;

  const snapshot = await loadRepository(octokit, repo);
  const { stale, skipped } = classifyBranches(snapshot.branches, {
    defaultBranch: snapshot.defaultBranch,
    daysInactive,
    protectedPatterns,
    openPullRequestBases: snapshot.openPullRequestBases,
  });

  core.info(
    `${snapshot.branches.length} branches scanned: ${stale.length} stale, ${skipped.length} kept ` +
      `(inactive for more than ${daysInactive} days, no open pull request).`,
  );
  for (const branch of skipped) core.debug(`keep ${branch.name}: ${branch.reason}`);

  const selected = stale.slice(0, maxDeletions);
  if (stale.length > selected.length) {
    core.warning(
      `${stale.length} stale branches found, limited to ${maxDeletions} by "max-deletions". ` +
        "The remaining ones will be handled on the next run.",
    );
  }

  const deleted: StaleBranch[] = [];
  const failed: string[] = [];

  for (const branch of selected) {
    const label = `${branch.name} (last commit ${branch.daysInactive} days ago)`;
    if (dryRun) {
      core.info(`[dry-run] would delete ${label}`);
      continue;
    }
    try {
      const removed = await deleteBranch(octokit, repo, branch.name);
      if (removed) deleted.push(branch);
      core.info(removed ? `deleted ${label}` : `already gone: ${branch.name}`);
    } catch (error) {
      failed.push(branch.name);
      core.warning(`Could not delete ${branch.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  core.setOutput("stale-branches", JSON.stringify(selected.map((branch) => branch.name)));
  core.setOutput("deleted-branches", JSON.stringify(deleted.map((branch) => branch.name)));
  core.setOutput("deleted-count", deleted.length);

  await writeSummary(
    dryRun ? `Stale branches (dry run): ${selected.length}` : `Deleted branches: ${deleted.length}`,
    dryRun ? selected : deleted,
    failed,
  );

  if (failed.length > 0) {
    core.setFailed(`Failed to delete ${failed.length} branch(es): ${failed.join(", ")}`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
