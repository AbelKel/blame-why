/**
 * Interactive terminal viewer for file change history.
 *
 * Renders one commit at a time in a full-screen view and lets the user
 * scroll through entries with arrow keys / j-k.  PR info is fetched lazily
 * as each entry is visited so we don't hammer the API for large histories.
 */

import { formatLogEntry, printWarning } from "./formatter.js";
import { getPullRequestsForCommit, GitHubApiError } from "./github.js";
import type { Config, FileLogEntry, GitRemote, BlameInfo } from "./types.js";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Launches the interactive log viewer.
 *
 * Resolves when the user presses `q` or when stdin closes.
 */
export async function startLogViewer(
  blameEntries: BlameInfo[],
  remote: GitRemote | null,
  filename: string,
  config: Config
): Promise<void> {
  if (blameEntries.length === 0) {
    console.log("  No changes found.");
    return;
  }

  // Wrap raw blame entries into FileLogEntry with lazy PR state.
  const entries: FileLogEntry[] = blameEntries.map((blame) => ({
    blame,
    pullRequest: null,
    prFetched: false,
  }));

  let currentIndex = 0;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function render(): void {
    // Clear screen and move cursor to top-left.
    process.stdout.write("\x1B[2J\x1B[H");

    const entry = entries[currentIndex]!;
    const lines = formatLogEntry(
      entry,
      currentIndex,
      entries.length,
      filename,
      remote
    );

    for (const line of lines) {
      console.log(line);
    }
  }

  async function fetchPrIfNeeded(): Promise<void> {
    const entry = entries[currentIndex]!;
    if (entry.prFetched) return;
    if (!remote || entry.blame.isUncommitted) {
      entry.prFetched = true;
      return;
    }

    // Render with "fetching…" indicator first.
    render();

    try {
      const prs = await getPullRequestsForCommit(
        remote.owner,
        remote.repo,
        entry.blame.commitHash,
        config
      );
      entry.pullRequest = prs.length > 0 ? prs[0]! : null;
    } catch (err) {
      // Non-fatal — just mark as fetched with no PR.
      const msg =
        err instanceof GitHubApiError ? err.message :
        err instanceof Error ? err.message :
        String(err);
      printWarning(msg);
      entry.pullRequest = null;
    }

    entry.prFetched = true;
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  // Enable raw mode so we get individual keypresses.
  if (!process.stdin.isTTY) {
    // Non-interactive — just dump all entries sequentially and exit.
    for (let i = 0; i < entries.length; i++) {
      currentIndex = i;
      await fetchPrIfNeeded();
      const entry = entries[i]!;
      const lines = formatLogEntry(entry, i, entries.length, filename, remote);
      for (const line of lines) {
        console.log(line);
      }
      console.log();
    }
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  // Fetch and render the first entry.
  await fetchPrIfNeeded();
  render();

  return new Promise<void>((resolve) => {
    // We accumulate bytes because escape sequences (arrow keys) arrive as
    // multi-byte chunks: e.g. \x1B[A for up-arrow.
    process.stdin.on("data", async (key: string) => {
      const quit = (): void => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        // Clear screen on exit.
        process.stdout.write("\x1B[2J\x1B[H");
        resolve();
      };

      // q / Ctrl-C — quit
      if (key === "q" || key === "Q" || key === "\x03") {
        quit();
        return;
      }

      let moved = false;

      // Down / j — next entry
      if (key === "j" || key === "\x1B[B") {
        if (currentIndex < entries.length - 1) {
          currentIndex++;
          moved = true;
        }
      }

      // Up / k — previous entry
      if (key === "k" || key === "\x1B[A") {
        if (currentIndex > 0) {
          currentIndex--;
          moved = true;
        }
      }

      // Home / g — first entry
      if (key === "g") {
        if (currentIndex !== 0) {
          currentIndex = 0;
          moved = true;
        }
      }

      // End / G — last entry
      if (key === "G") {
        if (currentIndex !== entries.length - 1) {
          currentIndex = entries.length - 1;
          moved = true;
        }
      }

      if (moved) {
        await fetchPrIfNeeded();
        render();
      }
    });
  });
}
