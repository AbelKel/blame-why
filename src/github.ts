/**
 * GitHub API module.
 *
 * All GitHub REST API calls live here. Uses the native Node 18+ fetch API
 * so no HTTP client dependency is needed.
 *
 * Endpoints used:
 *   GET /repos/{owner}/{repo}/commits/{sha}/pulls  — PRs for a commit
 *   GET /repos/{owner}/{repo}/pulls/{num}/comments — Review comments
 *   GET /repos/{owner}/{repo}/issues/{num}         — Issue details
 */

import type {
  Config,
  PullRequest,
  Issue,
  ReviewComment,
  GitHubPRResponse,
  GitHubIssueResponse,
  GitHubReviewCommentResponse,
} from "./types.js";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns all pull requests that include the given commit SHA.
 * Enriches each PR with linked issues parsed from its description body.
 *
 * Returns an empty array (not an error) when the commit is not part of any PR.
 */
export async function getPullRequestsForCommit(
  owner: string,
  repo: string,
  commitSha: string,
  config: Config
): Promise<PullRequest[]> {
  const url = `${config.githubApiBase}/repos/${owner}/${repo}/commits/${commitSha}/pulls`;
  const response = await githubFetch(url, config);

  if (!response.ok) {
    // 404 / 422 mean the commit simply isn't in any PR — treat as empty.
    if (response.status === 404 || response.status === 422) return [];
    await throwApiError(response, "fetching PRs for commit");
  }

  const rawPrs = (await response.json()) as GitHubPRResponse[];

  // Enrich all PRs concurrently.
  return Promise.all(
    rawPrs.map((pr) => enrichPullRequest(pr, owner, repo, config))
  );
}

/**
 * Returns the review comments (inline diff comments) for a pull request.
 * Capped at config.maxComments, ordered newest-first.
 * Returns [] on any error — this data is supplementary, not critical.
 */
export async function getReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  config: Config
): Promise<ReviewComment[]> {
  const url =
    `${config.githubApiBase}/repos/${owner}/${repo}/pulls/${prNumber}/comments` +
    `?per_page=100&sort=created&direction=desc`;

  const response = await githubFetch(url, config);
  if (!response.ok) return [];

  const raw = (await response.json()) as GitHubReviewCommentResponse[];

  return raw.slice(0, config.maxComments).map((c) => ({
    id: c.id,
    author: c.user.login,
    body: c.body.trim(),
    path: c.path,
    // Prefer the new-file line; fall back to the original-file line.
    line: c.line ?? c.original_line,
    createdAt: c.created_at,
    htmlUrl: c.html_url,
  }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetches full PR detail and attaches linked issues.
 */
async function enrichPullRequest(
  raw: GitHubPRResponse,
  owner: string,
  repo: string,
  config: Config
): Promise<PullRequest> {
  const linkedIssueNumbers = parseLinkedIssues(raw.body ?? "");

  // Fetch all linked issues concurrently; silently drop any that fail.
  const linkedIssues = (
    await Promise.all(
      linkedIssueNumbers.map((num) =>
        fetchIssue(owner, repo, num, config).catch(() => null)
      )
    )
  ).filter((i): i is Issue => i !== null);

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state as "open" | "closed",
    htmlUrl: raw.html_url,
    author: raw.user.login,
    mergedAt: raw.merged_at,
    createdAt: raw.created_at,
    labels: raw.labels.map((l) => l.name),
    linkedIssues,
  };
}

/**
 * Fetches a single GitHub issue by number.
 */
async function fetchIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  config: Config
): Promise<Issue> {
  const url = `${config.githubApiBase}/repos/${owner}/${repo}/issues/${issueNumber}`;
  const response = await githubFetch(url, config);

  if (!response.ok) {
    await throwApiError(response, `fetching issue #${issueNumber}`);
  }

  const raw = (await response.json()) as GitHubIssueResponse;
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    htmlUrl: raw.html_url,
    state: raw.state as "open" | "closed",
    author: raw.user.login,
    labels: raw.labels.map((l) => l.name),
  };
}

/**
 * Performs an authenticated fetch to the GitHub API.
 * Attaches the required Accept and version headers.
 */
async function githubFetch(url: string, config: Config): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "blame-why/1.0.0 (https://github.com/blame-why/blame-why)",
  };

  if (config.githubToken) {
    headers["Authorization"] = `Bearer ${config.githubToken}`;
  }

  return fetch(url, { headers });
}

// ─── Issue link parser ────────────────────────────────────────────────────────

/**
 * Extracts issue numbers from GitHub "closing keywords" in a PR body.
 *
 * Handles all GitHub-recognized keywords:
 *   close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved
 *
 * Also handles cross-repo references like `Closes owner/repo#123` — in that
 * case the issue number is extracted but we query the same repo (the one
 * the PR was opened against). This is intentional — cross-repo issues are
 * rare and the number alone is the most useful part for quick context.
 *
 * @see https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 */
export function parseLinkedIssues(body: string): number[] {
  const pattern =
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)?#(\d+)/gi;

  const seen = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    // match[1] is guaranteed by the regex capture group.
    seen.add(parseInt(match[1]!, 10));
  }

  return Array.from(seen);
}

// ─── Error helpers ────────────────────────────────────────────────────────────

/** Custom error class that preserves the HTTP status code for callers. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** Reads the error body and throws a typed GitHubApiError. Never returns. */
async function throwApiError(
  response: Response,
  context: string
): Promise<never> {
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : "";
  } catch {
    // Body wasn't JSON — ignore.
  }

  throw new GitHubApiError(
    `GitHub API error while ${context} (HTTP ${response.status}${detail})`,
    response.status
  );
}
