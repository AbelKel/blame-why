#!/usr/bin/env node
/**
 * blame-why — Enrich git blame with PR context.
 *
 * Usage: blame-why <file> <line> [options]
 *
 * Entry point: parses CLI arguments, orchestrates the git + GitHub lookups,
 * and delegates rendering to the formatter.
 */

import { program } from "commander";
import path from "path";
import { getBlameForLine, getLastCommitForFile, getGitRemote } from "./git.js";
import { getPullRequestsForCommit, getReviewComments, GitHubApiError } from "./github.js";
import { printResult, printError, printWarning } from "./formatter.js";
import type { BlameWhyResult, Config } from "./types.js";

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

Environment variables:
  GITHUB_TOKEN     Personal access token for GitHub API (recommended)
  GITHUB_API_BASE  Override API base URL for GitHub Enterprise
                   (default: https://api.github.com)
`
  );

program.parse();

// ─── Options types ────────────────────────────────────────────────────────────

interface CliOptions {
  remote: string;
  comments: boolean;
  maxComments: string;
  json: boolean;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Commander populates program.args after parse(); the arguments are typed as
// string[] but noUncheckedIndexedAccess makes element access return string|undefined.
const rawFileArg: string | undefined = program.args[0];
const rawLineArg: string | undefined = program.args[1];
const options = program.opts<CliOptions>();

if (!rawFileArg) {
  program.help();
  process.exit(0);
}

// Validate line number when provided.
let lineNumber: number | null = null;
if (rawLineArg) {
  lineNumber = parseInt(rawLineArg, 10);
  if (isNaN(lineNumber) || lineNumber < 1) {
    printError("Line number must be a positive integer (e.g. 42).");
    process.exit(1);
  }
}

const fileArg: string = rawFileArg;

main(fileArg, lineNumber, options).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  printError(message);
  process.exit(1);
});

// ─── Orchestration ────────────────────────────────────────────────────────────

async function main(
  fileArg: string,
  lineNumber: number | null,
  options: CliOptions
): Promise<void> {
  // Build runtime config from env + CLI options.
  const config: Config = {
    githubToken: process.env["GITHUB_TOKEN"] ?? null,
    githubApiBase:
      process.env["GITHUB_API_BASE"] ?? "https://api.github.com",
    maxComments: Math.max(1, parseInt(options.maxComments, 10) || 5),
  };

  if (!config.githubToken) {
    printWarning(
      "GITHUB_TOKEN not set. GitHub API requests will be unauthenticated " +
        "(60 req/hr limit). Set GITHUB_TOKEN to increase this to 5,000 req/hr."
    );
  }

  // Resolve file path against cwd so relative paths work from any directory.
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
        // When a commit is included in multiple PRs (e.g. cherry-picked),
        // use the first one returned — GitHub returns them in merge order.
        // Non-null assertion is safe: we just checked prs.length > 0.
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
      // GitHub errors are non-fatal — we still show the blame info.
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
    // Raw JSON output for scripting / piping.
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true for github.com and GitHub Enterprise hostnames. */
function isGitHub(host: string): boolean {
  // github.com and any *.github.com, plus common GHE patterns like github.myco.com
  return host === "github.com" || host.includes("github");
}
