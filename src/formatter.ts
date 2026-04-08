/**
 * Output formatting module.
 *
 * Responsible for all terminal rendering. Nothing outside this file should
 * call console.log directly
 */

import chalk from "chalk";
import type { BlameWhyResult, BlameInfo, PullRequest, Issue, ReviewComment } from "./types.js";


const WIDTH = 72;
const HEAVY_RULE = chalk.dim("─".repeat(WIDTH));
const LIGHT_RULE = chalk.dim("·".repeat(WIDTH));
const INDENT = "  ";


/**
 * Renders the complete blame-why result to stdout.
 * This is the sole public function in this module.
 */
export function printResult(result: BlameWhyResult): void {
  console.log();
  printBlameSection(result.blame);

  if (!result.remote) {
    console.log();
    console.log(
      chalk.yellow(
        `${INDENT} No GitHub remote detected! showing git blame info only.`
      )
    );
    console.log();
    return;
  }

  // Warning (non-fatal GitHub error) 
  if (result.warning) {
    console.log();
    console.log(chalk.yellow(`${INDENT}⚠  ${result.warning}`));
  }

  //No linked PR
  if (!result.pullRequest) {
    console.log();
    console.log(
      chalk.dim(
        `${INDENT} No pull request found for commit ${result.blame.shortHash}.`
      )
    );
    console.log(
      chalk.dim(
        `${INDENT}   This commit may have been pushed directly to the default branch.`
      )
    );
    console.log();
    return;
  }

  // PR + optional sections
  console.log();
  printPullRequestSection(result.pullRequest);

  if (result.pullRequest.linkedIssues.length > 0) {
    console.log();
    printIssuesSection(result.pullRequest.linkedIssues);
  }

  if (result.reviewComments.length > 0) {
    console.log();
    printReviewCommentsSection(result.reviewComments);
  }

  console.log();
}

/** Prints error message to stderr. */
export function printError(message: string): void {
  process.stderr.write(
    chalk.red.bold(`\n Error: `) + chalk.red(message) + "\n\n"
  );
}

/** Prints a yellow warning to stderr. */
export function printWarning(message: string): void {
  process.stderr.write(chalk.yellow(`  Warning: `) + message + "\n");
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function printBlameSection(blame: BlameInfo): void {
  const isFileLevel = blame.lineNumber === 0;

  // ── Header ────────────────────────────────────────────────────────────────
  console.log(HEAVY_RULE);
  console.log(
    `${INDENT}${chalk.bold.cyan("blame-why")}` +
      chalk.dim(isFileLevel
        ? `  ${blame.filename}  (last change)`
        : `  ${blame.filename}:${blame.lineNumber}`)
  );
  console.log(HEAVY_RULE);
  console.log();

  // ── Source line (skip for file-level view) ────────────────────────────────
  if (!isFileLevel) {
    const lineLabel = chalk.dim(`L${blame.lineNumber} `);
    const lineContent = blame.isUncommitted
      ? chalk.italic.dim(blame.lineContent || "(empty)")
      : chalk.white(blame.lineContent || "(empty)");
    console.log(`${INDENT}${lineLabel}${lineContent}`);
    console.log();
  }

  // ── Commit metadata ───────────────────────────────────────────────────────
  if (blame.isUncommitted) {
    console.log(
      `${INDENT}${label("Commit")}${chalk.yellow("(not yet committed)")}`
    );
  } else {
    console.log(
      `${INDENT}${label("Commit")}` +
        chalk.yellow(blame.shortHash) +
        chalk.dim(`  ${blame.commitHash}`)
    );
    console.log(`${INDENT}${label("Summary")}${chalk.white(blame.summary)}`);
  }

  console.log(
    `${INDENT}${label("Author ")}` +
      chalk.green(blame.author) +
      chalk.dim(`  <${blame.authorEmail}>`)
  );
  console.log(
    `${INDENT}${label("Date   ")}` +
      chalk.white(formatDate(blame.authorTime)) +
      chalk.dim(`  (${blame.authorTimezone})`)
  );

  // Only show committer when it differs from the author (e.g. squash merges).
  if (!blame.isUncommitted && blame.committer !== blame.author) {
    console.log(
      `${INDENT}${label("Commit ")}` +
        chalk.green(blame.committer) +
        chalk.dim(`  <${blame.committerEmail}>`)
    );
  }

  if (blame.isBoundary) {
    console.log(
      chalk.dim(`\n${INDENT}  (initial commit — no parent history)`)
    );
  }
}

function printPullRequestSection(pr: PullRequest): void {
  const stateTag =
    pr.mergedAt
      ? chalk.magenta("[merged]")
      : pr.state === "open"
        ? chalk.green("[open]")
        : chalk.red("[closed]");

  console.log(HEAVY_RULE);
  console.log(
    `${INDENT}${chalk.bold.blue(`Pull Request #${pr.number}`)}  ${stateTag}`
  );
  console.log(HEAVY_RULE);
  console.log();

  // Title + meta
  console.log(`${INDENT}${chalk.bold.white(pr.title)}`);
  const byLine =
    chalk.dim(`  by @${pr.author}`) +
    (pr.mergedAt
      ? chalk.dim(`  ·  merged ${formatDate(new Date(pr.mergedAt))}`)
      : chalk.dim(`  ·  opened ${formatDate(new Date(pr.createdAt))}`));
  console.log(`${INDENT}${byLine}`);
  console.log(`${INDENT}${chalk.dim.underline(pr.htmlUrl)}`);

  // Labels
  if (pr.labels.length > 0) {
    const tags = pr.labels
      .map((l) => chalk.bgBlackBright.white(` ${l} `))
      .join(" ");
    console.log(`\n${INDENT}${tags}`);
  }

  // Description body
  if (pr.body && pr.body.trim()) {
    console.log();
    console.log(`${INDENT}${chalk.bold("Description:")}`);
    printBody(pr.body, 700);
  }
}

function printIssuesSection(issues: Issue[]): void {
  console.log(LIGHT_RULE);
  console.log(
    `${INDENT}${chalk.bold.yellow("Linked Issues")}` +
      chalk.dim(`  (${issues.length})`)
  );

  for (const issue of issues) {
    console.log();

    const stateTag =
      issue.state === "open"
        ? chalk.green("[open]")
        : chalk.red("[closed]");

    console.log(
      `${INDENT}${chalk.bold(`#${issue.number}`)}  ` +
        chalk.white(issue.title) +
        `  ${stateTag}`
    );
    console.log(`${INDENT}${chalk.dim.underline(issue.htmlUrl)}`);

    if (issue.labels.length > 0) {
      const tags = issue.labels
        .map((l) => chalk.bgBlackBright.white(` ${l} `))
        .join(" ");
      console.log(`${INDENT}${tags}`);
    }

    if (issue.body && issue.body.trim()) {
      printBody(issue.body, 250);
    }
  }
}

function printReviewCommentsSection(comments: ReviewComment[]): void {
  console.log(LIGHT_RULE);
  console.log(
    `${INDENT}${chalk.bold.yellow("Review Comments")}` +
      chalk.dim(`  (${comments.length})`)
  );

  for (const comment of comments) {
    console.log();
    const meta =
      chalk.green(`@${comment.author}`) +
      chalk.dim(
        `  ·  ${comment.path}` +
          (comment.line !== null ? `:${comment.line}` : "") +
          `  ·  ${formatDate(new Date(comment.createdAt))}`
      );
    console.log(`${INDENT}${meta}`);
    printBody(comment.body, 350);
  }
}

// ─── Formatting utilities ─────────────────────────────────────────────────────

/** Prints a text body with indentation, normalizing line endings. */
function printBody(body: string, maxChars: number): void {
  const clean = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const truncated =
    clean.length > maxChars
      ? clean.substring(0, maxChars).trimEnd() + "\n…"
      : clean;

  truncated.split("\n").forEach((line) => {
    console.log(`    ${chalk.dim(line)}`);
  });
}

/** Left-aligned fixed-width label. */
function label(text: string): string {
  return chalk.bold(text.padEnd(8)) + " ";
}

/**
 * Formats a Date as a short human-readable string.
 * e.g. "Jan 15, 2024 at 02:30 PM"
 */
function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
