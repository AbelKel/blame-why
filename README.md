# blame-why

> `git blame` tells you **who** and **when**. `blame-why` tells you **why**.

Enrich git blame output with the linked pull request, issue description, and review comments — all inline in your terminal. Stop context-switching between your editor, GitHub, and Jira just to understand a single line of code.

```
$ blame-why src/auth.ts 42
```

```
────────────────────────────────────────────────────────────────────────
  blame-why  src/auth.ts:42
────────────────────────────────────────────────────────────────────────

  L42   const hash = await bcrypt.hash(password, SALT_ROUNDS);

  Commit   a3f9d2b1  a3f9d2b1c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9
  Summary  Switch to bcrypt for password hashing
  Author   Jane Doe  <jane@example.com>
  Date     Mar 15, 2024, 02:30 PM  (+0000)

────────────────────────────────────────────────────────────────────────
  Pull Request #234  [merged]
────────────────────────────────────────────────────────────────────────

  Replace MD5 password hashing with bcrypt
  by @janedoe  ·  merged Mar 15, 2024, 03:45 PM
  https://github.com/example/repo/pull/234

  Description:
    MD5 is cryptographically broken and must not be used for password
    storage. This PR migrates auth to bcrypt with a cost factor of 12,
    matching OWASP recommendations.

·······································································
  Linked Issues  (1)

  #123  Security: MD5 password hashing is insecure  [closed]
  https://github.com/example/repo/issues/123
    Reported by the security team audit in Q1. MD5 is vulnerable to
    rainbow table attacks and fast brute-force.

·······································································
  Review Comments  (1)

  @alice  ·  src/auth.ts:42  ·  Mar 15, 2024, 03:10 PM
    Should we expose SALT_ROUNDS as a config value so ops can tune it?
```

## Features

- **PR context** — Title, description, author, and merge date at a glance
- **Linked issues** — Automatically parsed from `Closes #123` / `Fixes #456` keywords in the PR body
- **Review comments** — The inline discussion that shaped the code
- **Interactive file log** — Browse all changes to a file with `blame-why log`, scrolling through commits with linked PRs
- **Branch support** — View history for any branch with `--branch`
- **Graceful fallback** — Works without `GITHUB_TOKEN`, and degrades cleanly when no PR exists
- **JSON output** — `--json` flag for scripting and editor integrations
- **GitHub Enterprise** — Override the API base URL via `GITHUB_API_BASE`

## Installation

### From npm (recommended)

```bash
npm install -g blame-why
```

### From source

```bash
git clone https://github.com/AbelKel/blame-why.git
cd blame-why
npm install
npm run build
npm link        # installs the `blame-why` binary globally
```

## Setup

Set your GitHub personal access token so API requests are authenticated (5,000 req/hr instead of 60):

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

Add this to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) to make it permanent.

You can create a token at **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**. The only scope required is **read access to pull requests and issues** on the relevant repositories.

## Usage

```
blame-why <file> [line] [options]
blame-why log <file> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `file`   | Path to the source file (relative to cwd or absolute) |
| `line`   | 1-based line number to inspect (if omitted, shows the last change to the file) |

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-r, --remote <name>` | Git remote name to resolve as GitHub origin | `origin` |
| `--no-comments` | Skip fetching inline review comments (faster) | — |
| `--max-comments <n>` | Max review comments to display | `5` |
| `--json` | Output raw JSON instead of formatted text | — |
| `-v, --version` | Print version | — |
| `-h, --help` | Show help | — |

### `log` subcommand

Browse all changes to a file interactively, with linked PR info for each commit.

```
blame-why log <file> [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `-r, --remote <name>` | Git remote name to resolve as GitHub origin | `origin` |
| `-b, --branch <name>` | Branch or ref to show history for | current HEAD |
| `--max <n>` | Maximum number of commits to load | `200` |
| `--json` | Output raw JSON instead of the interactive viewer | — |

**Navigation:** `↑`/`k` previous · `↓`/`j` next · `g` first · `G` last · `q` quit

### Environment variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub personal access token (recommended) |
| `GITHUB_API_BASE` | Override for GitHub Enterprise (e.g. `https://github.myco.com/api/v3`) |

### Examples

```bash
# Basic usage
blame-why src/auth.ts 42

# Skip review comments for a faster response
blame-why lib/parser.js 108 --no-comments

# Use a different remote (e.g. an upstream fork)
blame-why src/index.ts 7 --remote upstream

# Pipe JSON output into jq
blame-why src/routes.ts 55 --json | jq '.pullRequest.title'

# GitHub Enterprise
GITHUB_API_BASE=https://github.myco.com/api/v3 blame-why src/app.ts 12

# Browse all changes to a file interactively
blame-why log src/auth.ts

# Browse changes on a specific branch
blame-why log src/auth.ts --branch main

# Browse changes on a different remote
blame-why log src/auth.ts --branch main --remote upstream

# Export file change history as JSON
blame-why log src/routes.ts --json --max 50
```

## How it works

### Single-line blame

1. **`git blame --porcelain`** is run for the specified file and line, giving the commit SHA, author, date, and commit message
2. The git **remote URL** is parsed to extract the GitHub owner and repo
3. **GitHub REST API** — [`GET /repos/{owner}/{repo}/commits/{sha}/pulls`](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit) — finds PRs that contain the commit
4. The PR body is scanned for **closing keywords** (`Closes #N`, `Fixes #N`, `Resolves #N`) and linked issues are fetched
5. **Review comments** for the PR are fetched and filtered to the most recent `--max-comments`
6. Everything is rendered with colour via [chalk](https://github.com/chalk/chalk)

### File log (`blame-why log`)

1. **`git log`** is run for the file (optionally filtered to a branch) to collect all commits
2. An **interactive full-screen viewer** renders one commit at a time
3. **PR info is fetched lazily** — only when you navigate to a commit, keeping API usage low
4. Each entry shows the commit metadata and a **clickable link to the PR** that introduced the change

## Architecture

```
src/
├── index.ts       CLI entry point — argument parsing and orchestration
├── git.ts         Git operations (blame, log, remote URL parsing)
├── github.ts      GitHub REST API calls and response mapping
├── formatter.ts   All terminal output — chalk colours, layout, truncation
├── viewer.ts      Interactive full-screen viewer for file log browsing
└── types.ts       TypeScript interfaces shared across modules
```

Each module has a single responsibility and is independently testable. The formatter is the only module that calls `console.log`; all others are pure functions that return structured data.

## Fallback behaviour

| Situation | Behaviour |
|-----------|-----------|
| No GitHub remote | Shows git blame info only |
| No `GITHUB_TOKEN` set | Proceeds unauthenticated (60 req/hr); shows a warning |
| Commit not in any PR | Shows git blame info + "no PR found" note |
| GitHub API error | Shows git blame info + warning message (non-fatal) |
| Uncommitted line | Shows author as pending, skips GitHub lookup |
| Line out of range | Exits with a clear error message |

## Screenshots

<!-- Add screenshots here after recording a terminal session -->
<!-- Suggested tool: https://github.com/faressoft/terminalizer -->

## Contributing

```bash
git clone https://github.com/AbelKel/blame-why.git
cd blame-why
npm install
npm run lint   # type-check only, no emit
npm run build  # compile to dist/
```

## License

MIT
