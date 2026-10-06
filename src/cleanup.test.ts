import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BranchInfo, type CleanupOptions, classifyBranches, matchesAny, parseList } from "./cleanup.js";

const now = new Date("2026-06-01T00:00:00Z");

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function branch(name: string, days: number, overrides: Partial<BranchInfo> = {}): BranchInfo {
  return { name, lastCommitDate: daysAgo(days), openPullRequests: 0, isProtected: false, ...overrides };
}

const options: CleanupOptions = {
  defaultBranch: "main",
  daysInactive: 90,
  protectedPatterns: ["develop", "release/*"],
  openPullRequestBases: new Set(["epic/checkout"]),
  now,
};

describe("classifyBranches", () => {
  it("marks old branches without pull requests as stale", () => {
    const { stale } = classifyBranches([branch("feature/old", 120)], options);

    assert.deepEqual(stale, [{ name: "feature/old", lastCommitDate: daysAgo(120), daysInactive: 120 }]);
  });

  it("keeps branches with recent commits", () => {
    const { stale, skipped } = classifyBranches([branch("feature/new", 10), branch("feature/edge", 90)], options);

    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.name, "feature/edge");
    assert.deepEqual(skipped, [{ name: "feature/new", reason: "active" }]);
  });

  it("never deletes the default branch", () => {
    const { stale, skipped } = classifyBranches([branch("main", 500)], options);

    assert.equal(stale.length, 0);
    assert.equal(skipped[0]?.reason, "default-branch");
  });

  it("keeps protected branches and excluded patterns", () => {
    const { stale, skipped } = classifyBranches(
      [branch("production", 500, { isProtected: true }), branch("develop", 500), branch("release/1.2", 500)],
      options,
    );

    assert.equal(stale.length, 0);
    assert.deepEqual(
      skipped.map((item) => item.reason),
      ["protected", "excluded", "excluded"],
    );
  });

  it("keeps branches that are the head or the base of an open pull request", () => {
    const { stale, skipped } = classifyBranches(
      [branch("feature/in-review", 200, { openPullRequests: 1 }), branch("epic/checkout", 200)],
      options,
    );

    assert.equal(stale.length, 0);
    assert.deepEqual(
      skipped.map((item) => item.reason),
      ["open-pull-request", "open-pull-request"],
    );
  });

  it("orders stale branches from the oldest to the newest", () => {
    const { stale } = classifyBranches([branch("b", 100), branch("a", 300), branch("c", 200)], options);

    assert.deepEqual(
      stale.map((item) => item.name),
      ["a", "c", "b"],
    );
  });
});

describe("matchesAny", () => {
  it("matches exact names and globs", () => {
    assert.equal(matchesAny("develop", ["develop"]), true);
    assert.equal(matchesAny("develop-2", ["develop"]), false);
    assert.equal(matchesAny("release/1.0/hotfix", ["release/*"]), true);
    assert.equal(matchesAny("prerelease/1.0", ["release/*"]), false);
  });

  it("treats regex characters literally", () => {
    assert.equal(matchesAny("v1x0", ["v1.0"]), false);
    assert.equal(matchesAny("v1.0", ["v1.0"]), true);
  });
});

describe("parseList", () => {
  it("splits on commas and newlines", () => {
    assert.deepEqual(parseList("main, develop\nrelease/*\n\n"), ["main", "develop", "release/*"]);
    assert.deepEqual(parseList(""), []);
  });
});
