export interface BranchInfo {
  name: string;
  lastCommitDate: Date;
  /** Open pull requests that use this branch as their head. */
  openPullRequests: number;
  /** Covered by a branch protection rule or ruleset. */
  isProtected: boolean;
}

export interface CleanupOptions {
  defaultBranch: string;
  daysInactive: number;
  /** Branch names or glob patterns (`*` matches any characters) that are never deleted. */
  protectedPatterns: string[];
  /** Branches targeted by an open pull request. */
  openPullRequestBases: ReadonlySet<string>;
  now?: Date;
}

export type SkipReason = "default-branch" | "protected" | "excluded" | "open-pull-request" | "active";

export interface StaleBranch {
  name: string;
  lastCommitDate: Date;
  daysInactive: number;
}

export interface SkippedBranch {
  name: string;
  reason: SkipReason;
}

export interface Classification {
  stale: StaleBranch[];
  skipped: SkippedBranch[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(name));
}

/** Accepts a comma or newline separated list, as written in a workflow file. */
export function parseList(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function skipReason(branch: BranchInfo, options: CleanupOptions, cutoff: number): SkipReason | undefined {
  if (branch.name === options.defaultBranch) return "default-branch";
  if (branch.isProtected) return "protected";
  if (matchesAny(branch.name, options.protectedPatterns)) return "excluded";
  if (branch.openPullRequests > 0 || options.openPullRequestBases.has(branch.name)) return "open-pull-request";
  if (branch.lastCommitDate.getTime() > cutoff) return "active";
  return undefined;
}

/**
 * Splits branches into the ones that are safe to delete and the ones that
 * must be kept. A branch is stale when its last commit is older than
 * `daysInactive` and nothing else is holding on to it.
 */
export function classifyBranches(branches: BranchInfo[], options: CleanupOptions): Classification {
  const now = (options.now ?? new Date()).getTime();
  const cutoff = now - options.daysInactive * DAY_MS;

  const stale: StaleBranch[] = [];
  const skipped: SkippedBranch[] = [];

  for (const branch of branches) {
    const reason = skipReason(branch, options, cutoff);
    if (reason) {
      skipped.push({ name: branch.name, reason });
    } else {
      stale.push({
        name: branch.name,
        lastCommitDate: branch.lastCommitDate,
        daysInactive: Math.floor((now - branch.lastCommitDate.getTime()) / DAY_MS),
      });
    }
  }

  // Oldest first, so a deletion cap removes the most abandoned branches.
  stale.sort((a, b) => a.lastCommitDate.getTime() - b.lastCommitDate.getTime());
  return { stale, skipped };
}
