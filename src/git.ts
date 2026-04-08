/**
 * Git operations module.
 *
 * Handles all interactions with the local git repository:
 *   - Running git blame and parsing its porcelain output
 *   - Resolving remote URLs into structured GitRemote objects
 *   - Finding the repo root for relative path resolution
 */

import { execSync } from "child_process";
import type { BlameInfo, GitRemote } from "./types.js";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Runs `git blame --porcelain` for a single line and returns structured data.
 *
 * @param filePath  Absolute or repo-relative path to the file.
 * @param lineNumber  1-based line number.
 * @throws If the file is not tracked, the line is out of range, or we're not
 *         inside a git repo.
 */
export function getBlameForLine(
  filePath: string,
  lineNumber: number
): BlameInfo {
  let output: string;
  try {
    // -L <line>,<line> restricts blame to exactly one line.
    // --porcelain gives us a stable, machine-readable format.
    // -- separates the path from any flags that might look like options.
    output = execSync(
      `git blame --porcelain -L ${lineNumber},${lineNumber} -- "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    throw translateGitError(err, filePath);
  }

  if (!output.trim()) {
    throw new Error(
      `git blame returned no output for ${filePath}:${lineNumber}. ` +
        "Is the file tracked and the line number valid?"
    );
  }

  return parsePorcelainOutput(output, lineNumber);
}

/**
 * Returns the absolute path of the current git repository root.
 * @throws If the cwd is not inside a git repository.
 */
export function getRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "Not a git repository (or any of the parent directories)."
    );
  }
}

/**
 * Resolves the URL of a named remote into a structured GitRemote object.
 * Returns null if the remote does not exist or the URL cannot be parsed.
 */
export function getGitRemote(remoteName = "origin"): GitRemote | null {
  let rawUrl: string;
  try {
    rawUrl = execSync(`git remote get-url ${remoteName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }

  return parseRemoteUrl(rawUrl);
}

/**
 * Returns structured info about the most recent commit that touched a file.
 * Uses `git log -1` instead of `git blame`.
 *
 * @param filePath  Absolute or repo-relative path to the file.
 * @throws If the file is not tracked or we're not inside a git repo.
 */
export function getLastCommitForFile(filePath: string): BlameInfo {
  let output: string;
  try {
    // %H  = full hash
    // %an = author name
    // %ae = author email
    // %at = author timestamp (unix)
    // %ai = author date ISO (contains timezone at end, e.g. "2026-03-26 21:59:25 -0700")
    // %cn = committer name
    // %ce = committer email
    // %ct = committer timestamp (unix)
    // %s  = subject
    // Using %x00 (null byte) as delimiter for safe parsing.
    output = execSync(
      `git log -1 --format="%H%x00%an%x00%ae%x00%at%x00%ai%x00%cn%x00%ce%x00%ct%x00%s" -- "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    throw translateGitError(err, filePath);
  }

  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error(
      `No git history found for ${filePath}. ` +
        "Is the file tracked by git?"
    );
  }

  const parts = trimmed.split("\0");
  if (parts.length < 9) {
    throw new Error(`Unexpected git log output format for ${filePath}.`);
  }

  const commitHash = parts[0]!;
  const isUncommitted = commitHash === "0".repeat(40);

  // %ai gives "2026-03-26 21:59:25 -0700" — extract the timezone suffix.
  const authorDateIso = parts[4]!;
  const tzMatch = authorDateIso.match(/([+-]\d{4})$/);
  const authorTimezone = tzMatch ? tzMatch[1]! : "";

  // Extract just the filename relative to the repo root.
  let filename: string;
  try {
    filename = execSync(
      `git ls-files --full-name -- "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    filename = filePath;
  }

  return {
    commitHash,
    shortHash: commitHash.substring(0, 8),
    author: parts[1]!,
    authorEmail: parts[2]!,
    authorTime: new Date(parseInt(parts[3]!, 10) * 1000),
    authorTimezone,
    committer: parts[5]!,
    committerEmail: parts[6]!,
    committerTime: new Date(parseInt(parts[7]!, 10) * 1000),
    summary: parts[8]!,
    filename: filename || filePath,
    lineContent: "",
    lineNumber: 0,
    isBoundary: false,
    isUncommitted,
  };
}

// ─── Porcelain parser ─────────────────────────────────────────────────────────

/**
 * Parses the `--porcelain` output of git blame into a BlameInfo struct.
 *
 * Porcelain format reference:
 *   Line 1:   <40-hex-sha> <orig-line> <final-line> [<num-lines>]
 *   Lines 2…: <key> <value>  (author, author-mail, author-time, …)
 *   Last:     \t<line-content>  (tab-prefixed)
 */
function parsePorcelainOutput(raw: string, lineNumber: number): BlameInfo {
  const lines = raw.split("\n");

  // ── Header line ──────────────────────────────────────────────────────────
  const firstLine = lines[0];
  if (!firstLine) {
    throw new Error("git blame produced empty output.");
  }
  const headerMatch = firstLine.match(/^([0-9a-f]{40})\s+\d+\s+\d+/);
  if (!headerMatch) {
    throw new Error(`Unexpected git blame output format:\n${firstLine}`);
  }

  // Non-null assertion is safe here: the regex has a required capture group
  // and we just verified headerMatch is not null.
  const commitHash = headerMatch[1]!;
  const isUncommitted = commitHash === "0".repeat(40);

  // Use a partial type while we accumulate fields, then assert at the end.
  const info: Partial<BlameInfo> = {
    commitHash,
    shortHash: commitHash.substring(0, 8),
    lineNumber,
    isUncommitted,
    isBoundary: false,
  };

  // ── Key-value lines ───────────────────────────────────────────────────────
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Guard for noUncheckedIndexedAccess — split result is always defined
    // for valid indices, but the type system can't know that.
    if (line === undefined) continue;

    if (line.startsWith("\t")) {
      // The actual source line (always tab-prefixed, strip the tab).
      info.lineContent = line.substring(1);
      continue;
    }

    if (line === "boundary") {
      info.isBoundary = true;
      continue;
    }

    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;

    const key = line.substring(0, spaceIdx);
    const value = line.substring(spaceIdx + 1);

    switch (key) {
      case "author":
        info.author = value;
        break;
      case "author-mail":
        // Strip surrounding angle brackets: <jane@example.com> → jane@example.com
        info.authorEmail = value.replace(/^<|>$/g, "");
        break;
      case "author-time":
        info.authorTime = new Date(parseInt(value, 10) * 1000);
        break;
      case "author-tz":
        info.authorTimezone = value;
        break;
      case "committer":
        info.committer = value;
        break;
      case "committer-mail":
        info.committerEmail = value.replace(/^<|>$/g, "");
        break;
      case "committer-time":
        info.committerTime = new Date(parseInt(value, 10) * 1000);
        break;
      case "summary":
        info.summary = value;
        break;
      case "filename":
        info.filename = value;
        break;
    }
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const required: Array<keyof BlameInfo> = [
    "author",
    "authorEmail",
    "authorTime",
    "summary",
    "filename",
  ];
  for (const field of required) {
    if (info[field] === undefined) {
      throw new Error(
        `git blame output is missing required field "${field}". ` +
          "This is unexpected — please file a bug."
      );
    }
  }

  if (info.lineContent === undefined) {
    throw new Error(
      "git blame output is missing the line content. " +
        "Is the file binary or the line number out of range?"
    );
  }

  // Fill optional committer fields with author values when absent
  // (happens for the initial commit). Non-null assertions are safe here
  // because we just validated these fields exist in the loop above.
  info.committer ??= info.author!;
  info.committerEmail ??= info.authorEmail!;
  info.committerTime ??= info.authorTime!;

  return info as BlameInfo;
}

// ─── Remote URL parser ────────────────────────────────────────────────────────

/**
 * Parses both SSH and HTTPS git remote URL formats.
 *
 * SSH:   git@github.com:owner/repo.git
 * HTTPS: https://github.com/owner/repo.git
 *        https://token@github.com/owner/repo.git  (embedded auth)
 */
function parseRemoteUrl(rawUrl: string): GitRemote | null {
  // SSH: git@<host>:<owner>/<repo>[.git]
  const sshMatch = rawUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    // Groups 1–3 are guaranteed by the regex — non-null assertions are safe.
    return { host: sshMatch[1]!, owner: sshMatch[2]!, repo: sshMatch[3]!, rawUrl };
  }

  // HTTPS: https://[token@]<host>/<owner>/<repo>[.git]
  const httpsMatch = rawUrl.match(
    /^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return {
      host: httpsMatch[1]!,
      owner: httpsMatch[2]!,
      repo: httpsMatch[3]!,
      rawUrl,
    };
  }

  return null;
}

// ─── Error translation ────────────────────────────────────────────────────────

/** Converts raw execSync errors into user-friendly messages. */
function translateGitError(err: unknown, filePath: string): Error {
  const raw = err as Error & { stderr?: Buffer | string };
  const stderr =
    typeof raw.stderr === "string"
      ? raw.stderr
      : raw.stderr?.toString() ?? "";
  const combined = `${raw.message}\n${stderr}`.toLowerCase();

  if (combined.includes("no such path") || combined.includes("no such file")) {
    return new Error(
      `File not found in git history: ${filePath}\n` +
        "Make sure the path is correct and the file is tracked by git."
    );
  }
  if (
    combined.includes("not a git repository") ||
    combined.includes("not a git repo")
  ) {
    return new Error(
      "Not a git repository. Run blame-why from within a git project."
    );
  }
  if (combined.includes("bad revision") || combined.includes("unknown revision")) {
    return new Error(`Invalid git revision. Try running "git fetch" first.`);
  }

  return new Error(`git blame failed: ${stderr || raw.message}`);
}
