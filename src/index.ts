#!/usr/bin/env node
/**
 * blame-why — Enrich git blame with PR context.
 *
 * Usage: blame-why <file> <line> [options]
 *        blame-why log <file> [options]
 *
 * Entry point: parses CLI arguments, orchestrates the git + GitHub lookups,
 * and delegates rendering to the formatter.
 */

import { program } from "commander";
import path from "path";
import { getBlameForLine, getLastCommitForFile, getGitRemote, getFileLog } from "./git.js";
import { getPullRequestsForCommit, getReviewComments, GitHubApiError } from "./github.js";
import { printResult, printError, printWarning } from "./formatter.js";
import { startLogViewer } from "./viewer.js";
import type { BlameWhyResult, Config } from "./types.js";

// ─── Option interfaces ───────────────────────────────────────────────────────

interface CliOptions {
  remote: string;
  comments: boolean;
  maxComments: string;
  json: boolean;
}

interface LogCliOptions {
  remote: string;
  branch?: string;
  max: string;
  json: boolean;
}

// ─── CLI definition ───────────────────────────────────────────────────────────

program
  .name("blame-why")
  .description(
    "Enrich git blame output with PR title, description, and linked issues.\n" +
      "Instantly understand WHY a line of code changed — not just who and when."
  )
  .version("1.0.0", "-v, --version")
  .argument("<file>", "Path to the source file (relative to cwd or absolute)")
  .argument("[line]", "Line number to inspect (1-based). If omitted, shows the last change to the file.")
  .option(
    "-r, --remote <name>",
    "Git remote name to resolve as GitHub origin",
    "origin"
  )
  .option(
    "--no-comments",
    "Skip fetching inline review comments (faster)"
  )
  .option(
    "--max-comments <n>",
    "Maximum number of review comments to display",
    "5"
  )
  .option(
    "--json",
    "Output raw JSON instead of formatted text (useful for scripting)"
  )
  .addHelpText(
    "after",
    `
Examples:
  $ blame-why src/auth.ts 42
  $ blame-why src/auth.ts              (shows last change to file)
  $ blame-why lib/parser.js 108 --no-comments
  $ blame-why src/index.ts 7 --remote upstream

Subcommands:
  $ blame-why log src/index.ts         (browse all changes interactively)
  $ blame-why log src/index.ts --branch main

Environment variables:
  GITHUB_TOKEN     Personal access token for GitHub API (recommended)
  GITHUB_API_BASE  Override API base URL for GitHub Enterprise
                   (default: https://api.github.com)
`
  )
  .action(async (fileArg: string, lineArg: string | undefined, opts: CliOptions) => {
    try {
      let lineNumber: number | null = null;
      if (lineArg) {
        lineNumber = parseInt(lineArg, 10);
        if (isNaN(lineNumber) || lineNumber < 1) {
          printError("Line number must be a positive integer (e.g. 42).");
          process.exit(1);
        }
      }
      await runBlame(fileArg, lineNumber, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

// ─── "log" subcommand ─────────────────────────────────────────────────────────

program
  .command("log")
  .description(
    "Browse all changes to a file interactively.\n" +
      "Shows every commit that touched the file with linked PRs.\n" +
      "Use ↑/↓ or j/k to scroll, q to quit."
  )
  .argument("<file>", "Path to the source file (relative to cwd or absolute)")
  .option(
    "-r, --remote <name>",
    "Git remote name to resolve as GitHub origin",
    "origin"
  )
  .option(
    "-b, --branch <name>",
    "Branch or ref to show history for (defaults to current HEAD)"
  )
  .option(
    "--max <n>",
    "Maximum number of commits to load",
    "200"
  )
  .option(
    "--json",
    "Output raw JSON instead of the interactive viewer"
  )
  .action(async (fileArg: string, opts: LogCliOptions) => {
    try {
      await runLog(fileArg, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
      process.exit(1);
    }
  });

program.parse();

// ─── Shared helpers ───────────────────────────────────────────────────────────

function buildConfig(maxComments = 5): Config {
  return {
    githubToken: process.env["GITHUB_TOKEN"] ?? null,
    githubApiBase:
      process.env["GITHUB_API_BASE"] ?? "https://api.github.com",
    maxComments,
  };
}

function warnIfNoToken(config: Config): void {
  if (!config.githubToken) {
    printWarning(
      "GITHUB_TOKEN not set. GitHub API requests will be unauthenticated " +
        "(60 req/hr limit). Set GITHUB_TOKEN to increase this to 5,000 req/hr."
    );
  }
}

/** Returns true for github.com and GitHub Enterprise hostnames. */
function isGitHub(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

// ─── Blame command orchestration ──────────────────────────────────────────────

async function runBlame(
  fileArg: string,
  lineNumber: number | null,
  options: CliOptions
): Promise<void> {
  const config = buildConfig(Math.max(1, parseInt(options.maxComments, 10) || 5));
  warnIfNoToken(config);

  const absolutePath = path.resolve(process.cwd(), fileArg);

  // ── Step 1: git blame or last commit ──────────────────────────────────────
  const blame = lineNumber
    ? getBlameForLine(absolutePath, lineNumber)
    : getLastCommitForFile(absolutePath);

  // ── Step 2: GitHub remote ─────────────────────────────────────────────────
  const remote = getGitRemote(options.remote);

  const result: BlameWhyResult = {
    blame,
    remote,
    pullRequest: null,
    reviewComments: [],
  };

  // ── Step 3: GitHub enrichment ─────────────────────────────────────────────
  if (remote && isGitHub(remote.host) && !blame.isUncommitted) {
    try {
      const prs = await getPullRequestsForCommit(
        remote.owner,
        remote.repo,
        blame.commitHash,
        config
      );

      if (prs.length > 0) {
        const firstPr = prs[0]!;
        result.pullRequest = firstPr;

        if (options.comments) {
          result.reviewComments = await getReviewComments(
            remote.owner,
            remote.repo,
            firstPr.number,
            config
          );
        }
      }
    } catch (err) {
      const message =
        err instanceof GitHubApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result.warning = message;
    }
  }

  // ── Step 4: Output ────────────────────────────────────────────────────────
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
}

// ─── Log subcommand orchestration ─────────────────────────────────────────────

async function runLog(
  fileArg: string,
  options: LogCliOptions
): Promise<void> {
  const config = buildConfig();
  warnIfNoToken(config);

  const absolutePath = path.resolve(process.cwd(), fileArg);
  const maxCommits = Math.max(1, parseInt(options.max, 10) || 200);

  // ── Step 1: git log ────────────────────────────────────────────────────────
  const entries = getFileLog(absolutePath, maxCommits, options.branch);

  if (entries.length === 0) {
    printError(`No commits found for ${fileArg}.`);
    process.exit(1);
  }

  // ── Step 2: GitHub remote ─────────────────────────────────────────────────
  const remote = getGitRemote(options.remote);
  const isGh = remote ? isGitHub(remote.host) : false;

  // ── Step 3: Output ────────────────────────────────────────────────────────
  if (options.json) {
    const results = [];
    for (const blame of entries) {
      let pullRequest = null;
      if (remote && isGh && !blame.isUncommitted) {
        try {
          const prs = await getPullRequestsForCommit(
            remote.owner,
            remote.repo,
            blame.commitHash,
            config
          );
          pullRequest = prs.length > 0 ? prs[0]! : null;
        } catch {
          // Non-fatal.
        }
      }
      results.push({ blame, pullRequest });
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Interactive mode.
  await startLogViewer(entries, isGh ? remote : null, fileArg, config);
}
