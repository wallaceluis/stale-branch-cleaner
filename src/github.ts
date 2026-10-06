import type { getOctokit } from "@actions/github";
import type { BranchInfo } from "./cleanup.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface Repo {
  owner: string;
  repo: string;
}

export interface RepositorySnapshot {
  defaultBranch: string;
  branches: BranchInfo[];
  openPullRequestBases: Set<string>;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface BranchesQuery {
  repository: {
    defaultBranchRef: { name: string } | null;
    refs: {
      pageInfo: PageInfo;
      nodes: {
        name: string;
        associatedPullRequests: { totalCount: number };
        target: { committedDate?: string } | null;
      }[];
    };
  };
}

interface PullRequestsQuery {
  repository: {
    pullRequests: {
      pageInfo: PageInfo;
      nodes: { baseRefName: string }[];
    };
  };
}

// One request per 100 branches, instead of one commit lookup per branch.
const BRANCHES_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          associatedPullRequests(states: OPEN) { totalCount }
          target { ... on Commit { committedDate } }
        }
      }
    }
  }`;

const PULL_REQUESTS_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { baseRefName }
      }
    }
  }`;

async function listProtectedBranches(octokit: Octokit, repo: Repo): Promise<Set<string>> {
  // The REST flag also reflects rulesets, which the GraphQL ref does not expose to GITHUB_TOKEN.
  const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
    ...repo,
    protected: true,
    per_page: 100,
  });
  return new Set(branches.map((branch) => branch.name));
}

async function listOpenPullRequestBases(octokit: Octokit, repo: Repo): Promise<Set<string>> {
  const bases = new Set<string>();
  let cursor: string | null = null;
  do {
    const data: PullRequestsQuery = await octokit.graphql(PULL_REQUESTS_QUERY, { ...repo, cursor });
    const { nodes, pageInfo } = data.repository.pullRequests;
    for (const pullRequest of nodes) bases.add(pullRequest.baseRefName);
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return bases;
}

export async function loadRepository(octokit: Octokit, repo: Repo): Promise<RepositorySnapshot> {
  const [protectedBranches, openPullRequestBases] = await Promise.all([
    listProtectedBranches(octokit, repo),
    listOpenPullRequestBases(octokit, repo),
  ]);

  const branches: BranchInfo[] = [];
  let defaultBranch = "";
  let cursor: string | null = null;
  do {
    const data: BranchesQuery = await octokit.graphql(BRANCHES_QUERY, { ...repo, cursor });
    const { defaultBranchRef, refs } = data.repository;
    defaultBranch = defaultBranchRef?.name ?? defaultBranch;

    for (const node of refs.nodes) {
      // A branch without a readable commit date is left alone.
      if (!node.target?.committedDate) continue;
      branches.push({
        name: node.name,
        lastCommitDate: new Date(node.target.committedDate),
        openPullRequests: node.associatedPullRequests.totalCount,
        isProtected: protectedBranches.has(node.name),
      });
    }
    cursor = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (cursor);

  if (!defaultBranch) {
    throw new Error("Could not determine the default branch of the repository.");
  }
  return { defaultBranch, branches, openPullRequestBases };
}

/** Returns false when the branch was already gone. */
export async function deleteBranch(octokit: Octokit, repo: Repo, name: string): Promise<boolean> {
  try {
    await octokit.rest.git.deleteRef({ ...repo, ref: `heads/${name}` });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 422) return false;
    throw error;
  }
}
