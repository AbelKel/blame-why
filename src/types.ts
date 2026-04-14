/**
 * Core TypeScript interfaces for blame-why.
 * All external API shapes are defined here to keep other modules clean.
 */

// ─── Git ─────────────────────────────────────────────────────────────────────

/** Structured output from `git blame --porcelain` for a single line. */
export interface BlameInfo {
  commitHash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  authorTime: Date;
  authorTimezone: string;
  committer: string;
  committerEmail: string;
  committerTime: Date;
  summary: string;
  /** Path to the file as known by git (may differ from the arg if renamed). */
  filename: string;
  lineContent: string;
  lineNumber: number;
  /** True when the line comes from the very first commit (no parent). */
  isBoundary: boolean;
  /** True when the commit hash is all zeros — meaning the line is uncommitted. */
  isUncommitted: boolean;
}

/** Parsed GitHub repository coordinates extracted from a git remote URL. */
export interface GitRemote {
  /** e.g. "github.com" — kept generic to support GitHub Enterprise. */
  host: string;
  owner: string;
  repo: string;
  /** The original remote URL, before parsing. */
  rawUrl: string;
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

/** An enriched GitHub pull request with linked issue data attached. */
export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  htmlUrl: string;
  author: string;
  mergedAt: string | null;
  createdAt: string;
  labels: string[];
  linkedIssues: Issue[];
}

/** A GitHub issue. */
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: "open" | "closed";
  author: string;
  labels: string[];
}

/** An inline PR review comment (left on a specific line of a diff). */
export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  /** Line number in the file (null for comments on deleted lines). */
  line: number | null;
  createdAt: string;
  htmlUrl: string;
}

// ─── Result ──────────────────────────────────────────────────────────────────

/** The fully assembled result passed to the formatter. */
export interface BlameWhyResult {
  blame: BlameInfo;
  /** Null when run outside a GitHub-backed repo. */
  remote: GitRemote | null;
  /** Null when no PR is linked to the commit. */
  pullRequest: PullRequest | null;
  reviewComments: ReviewComment[];
  /** Non-fatal warning message to display (e.g. GitHub API error). */
  warning?: string;
}

// ─── File log ────────────────────────────────────────────────────────────────

/** A single entry in the file change log with optional PR enrichment. */
export interface FileLogEntry {
  blame: BlameInfo;
  pullRequest: PullRequest | null;
  /** Whether we've already attempted to fetch PR info for this entry. */
  prFetched: boolean;
}

// ─── Runtime config ──────────────────────────────────────────────────────────

export interface Config {
  githubToken: string | null;
  /** Override for GitHub Enterprise: e.g. "https://github.myco.com/api/v3" */
  githubApiBase: string;
  maxComments: number;
}

// ─── GitHub REST API raw shapes ───────────────────────────────────────────────
// These mirror the JSON returned by the GitHub API so we can type-assert safely.

export interface GitHubPRResponse {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string };
  merged_at: string | null;
  created_at: string;
  labels: Array<{ name: string }>;
}

export interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
}

export interface GitHubReviewCommentResponse {
  id: number;
  user: { login: string };
  body: string;
  path: string;
  /** Line in the *new* file (null for deletions). */
  line: number | null;
  /** Line in the original file before the diff was applied. */
  original_line: number | null;
  created_at: string;
  html_url: string;
}
