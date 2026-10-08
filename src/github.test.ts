import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deleteBranch, loadRepository } from "./github.js";

type Octokit = Parameters<typeof loadRepository>[0];
const repo = { owner: "acme", repo: "app" };

const branchNode = (name: string, committedDate: string | undefined, openPrs = 0) => ({
  name,
  associatedPullRequests: { totalCount: openPrs },
  target: committedDate ? { committedDate } : {},
});

/**
 * Minimal Octokit stand-in: GraphQL answers come from per-query page lists
 * (picked by the cursor), REST listBranches returns the protected names.
 */
function fakeOctokit(options: {
  branchPages: { nodes: unknown[]; defaultBranch?: string | null }[];
  prPages?: { baseRefName: string }[][];
  protected?: string[];
  deleteRef?: (ref: string) => Promise<unknown>;
}) {
  const calls = { graphql: [] as { query: string; cursor: string | null }[], deleted: [] as string[] };

  const pageFor = <T>(pages: T[], cursor: string | null) => {
    const index = cursor ? Number(cursor.replace("c", "")) : 0;
    return {
      page: pages[index]!,
      pageInfo: { hasNextPage: index < pages.length - 1, endCursor: index < pages.length - 1 ? `c${index + 1}` : null },
    };
  };

  const octokit = {
    async graphql(query: string, vars: { cursor: string | null }) {
      calls.graphql.push({ query, cursor: vars.cursor });
      if (query.includes("pullRequests(")) {
        const { page, pageInfo } = pageFor(options.prPages ?? [[]], vars.cursor);
        return { repository: { pullRequests: { nodes: page, pageInfo } } };
      }
      const { page, pageInfo } = pageFor(options.branchPages, vars.cursor);
      return {
        repository: {
          defaultBranchRef: page.defaultBranch === null ? null : { name: page.defaultBranch ?? "main" },
          refs: { nodes: page.nodes, pageInfo },
        },
      };
    },
    paginate: async () => (options.protected ?? []).map((name) => ({ name })),
    rest: {
      repos: { listBranches: () => undefined },
      git: {
        deleteRef: async ({ ref }: { ref: string }) => {
          calls.deleted.push(ref);
          return options.deleteRef ? options.deleteRef(ref) : {};
        },
      },
    },
  };
  return { octokit: octokit as unknown as Octokit, calls };
}

describe("loadRepository", () => {
  it("follows GraphQL pagination for branches and open pull request bases", async () => {
    const { octokit, calls } = fakeOctokit({
      branchPages: [
        { nodes: [branchNode("main", "2026-01-01T00:00:00Z"), branchNode("feat/a", "2025-01-01T00:00:00Z", 1)] },
        { nodes: [branchNode("old", "2024-06-01T00:00:00Z")] },
      ],
      prPages: [[{ baseRefName: "develop" }], [{ baseRefName: "release/1" }]],
      protected: ["main"],
    });

    const snapshot = await loadRepository(octokit, repo);

    assert.equal(snapshot.defaultBranch, "main");
    assert.deepEqual(
      snapshot.branches.map((b) => [b.name, b.openPullRequests, b.isProtected]),
      [
        ["main", 0, true],
        ["feat/a", 1, false],
        ["old", 0, false],
      ],
    );
    assert.deepEqual([...snapshot.openPullRequestBases].sort(), ["develop", "release/1"]);
    // Two pages each for branches and pull requests
    assert.equal(calls.graphql.length, 4);
    assert.equal(calls.graphql.filter((c) => c.cursor === "c1").length, 2);
  });

  it("skips branches whose last commit date cannot be read", async () => {
    const { octokit } = fakeOctokit({
      branchPages: [{ nodes: [branchNode("main", "2026-01-01T00:00:00Z"), branchNode("tag-like", undefined)] }],
    });
    const snapshot = await loadRepository(octokit, repo);
    assert.deepEqual(snapshot.branches.map((b) => b.name), ["main"]);
  });

  it("fails when the default branch is unknown", async () => {
    const { octokit } = fakeOctokit({ branchPages: [{ nodes: [], defaultBranch: null }] });
    await assert.rejects(loadRepository(octokit, repo), /default branch/);
  });
});

describe("deleteBranch", () => {
  it("deletes the heads/ ref", async () => {
    const { octokit, calls } = fakeOctokit({ branchPages: [] });
    assert.equal(await deleteBranch(octokit, repo, "feat/x"), true);
    assert.deepEqual(calls.deleted, ["heads/feat/x"]);
  });

  it("returns false when the branch is already gone (404/422)", async () => {
    for (const status of [404, 422]) {
      const { octokit } = fakeOctokit({ branchPages: [], deleteRef: () => Promise.reject({ status }) });
      assert.equal(await deleteBranch(octokit, repo, "gone"), false);
    }
  });

  it("rethrows other errors, like missing permissions", async () => {
    const { octokit } = fakeOctokit({ branchPages: [], deleteRef: () => Promise.reject({ status: 403, message: "forbidden" }) });
    await assert.rejects(deleteBranch(octokit, repo, "x"), (error: { status: number }) => error.status === 403);
  });
});
