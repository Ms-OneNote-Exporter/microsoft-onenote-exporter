# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-10-02

A **patch**, and the first release driven by the automation added in the previous
one rather than by remembering to check.

### Changed

- **`@msout/microsoft-onenote-list-notebooks` 0.0.6 → 0.0.7.** Pin bumped and the
  lockfile regenerated, so it now resolves that version from the registry rather
  than the previous tarball.

  The contract this adapter depends on is unchanged — `listNotebooks(options)`
  still returns `Array<{name, url, id}>`, and the module still exports
  `listNotebooks` and `dismissMcasInterstitial` — so no code here changed.

  What 0.0.7 brings, from its own release: real notebook URLs are resolved instead
  of the MRU placeholder, and links are read from the MRU feed in canonical form.
  That matters here because `list` prints `nb.url`, so the URLs this tool reports
  are now the ones that can actually be opened.

  0.0.6 was still pinned when this was written, which is what the `stale-steps`
  CI job reported on its first run and what Dependabot has a grouped PR open for.

### Fixed

- **`entrypoint.sh` offered `--output-dir` to every subcommand.** `list`, `check`
  and `logout` do not define that option, so all three died with
  `error: unknown option '--output-dir'` and exit 1 — the container refused to list
  anything, while the flag commander rejected had been added by the entrypoint
  itself. `export` kept working, and it was the only subcommand anyone had run
  through a container. Now gated on the subcommand actually being `export`.

  Two tests, both of which fail against the previous entrypoint: one asserts the
  injection sits *inside* the export gate by comparing source positions, because
  the earlier assertion checked only that the injection existed and not which
  subcommands it applied to — which is exactly why it passed against the broken
  version. The other pins the subcommand match by name.

- Related: **issue #3** — `start-container.sh` still refuses `list`, `check` and
  `logout` when given no flags, from a `$# -eq 0` guard written for `export` and
  applied to all five subcommands. Tracked, not yet fixed; both it and the
  entrypoint bug have to be resolved before `list` works through the wrapper.

Tests: 130 → 132.

## [0.1.2] - 2026-10-02

A **patch**. It changes what is published, not what the package does.

### Fixed

- **`entrypoint.sh` and `start-container.sh` are published again.** The `files`
  whitelist listed `src/` and the four documents, so the tarball had eleven files
  and neither container script — 0.1.0 and 0.1.1 both shipped that way. It
  mattered because six of the fixes in 0.1.1 live inside those two files, and
  because the README's Docker section is built on them: a consumer who installed
  the package and then tried to run a container from it had no entrypoint to
  build an image from and no wrapper to call.

  The publish gate missed it because it only ever checked what must *not* ship —
  no test suites, no auth state, no workflow files — and never what must. Two
  tests now cover that direction, and one of them checks the executable bit too,
  since a tarball carrying the scripts as `0644` would fail at the `ENTRYPOINT`
  line with `Cannot exec: permission denied`.

  Thirteen files, up from eleven.

### Changed

- **`docker-output/` is gitignored.** A container run pointed at that directory
  leaves `auth.json` beside the exported notes, and `git add -A` would have staged
  a live full-account session.

Tests: 128 → 130.

## [0.1.1] - 2026-10-01

A **patch**, and an unusual one: it fixes six bugs and changes no documented
behaviour. 0.1.0 built, installed and passed 102 tests, and could not export a
single note inside the container. Every bug here was found by running
`start-container.sh` against a real notebook and looking for Markdown on the
host — not by reading the code, and not by the test suite.

### Fixed

- **The container was never given the subcommand.** The wrapper forwarded the
  caller's flags verbatim, and the CLI takes the step as a subcommand, so the
  container received only `--notebook <name>` and answered
  `error: unknown option '--notebook'`. The wrapper now supplies `export` by
  default and accepts an explicit step.
- **The wrapper reported success while the export was still running.** The wait
  loop read `State.ExitCode` and stopped as soon as it was non-empty — and that
  field is `0` *while the container is running*. So it printed
  `Exported files are in: ...` for a run that had written nothing. It now uses
  `docker wait`, which blocks until the container stops, with a one-hour
  watchdog that reports rather than hangs.
- **Notes were written inside the image and lost on exit.** The container's
  working directory is `/app`, so the CLI's own default for `--output-dir` —
  `./output` against the cwd — resolved to `/app/output`. That directory exists
  and is writable, so the export ran to completion and logged
  `Files saved in: /app/output/<notebook>`, and every file died with the
  container: `/app/output` is inside the image, not the mounted volume. The
  entrypoint now points `--output-dir` at `/data/output` whenever a volume is
  mounted, and warns when none is.
- **The documented way to run could not run.** With the session in `./output`
  there is no second mount to make, so the optional-mount array was empty, and
  expanding an empty array under `set -u` failed with
  `AUTH_MOUNT[@]: unbound variable` before starting any container. The
  `~/.microsoft-webauth` fallback worked and hid it — the bug was invisible from
  the side of the code that happened to work.
- **The container name collided on every run after the first**, because the
  wrapper never removed what it created and the name is derived from the working
  directory.
- **The logger swallowed the error it was asked to report.** It formatted only
  its first argument, but the export step reports `logger.error('Export failed:',
  e)`, so a genuine failure printed the word `failed:` and nothing else — no
  message, no stack, and an empty log file. That is what concealed the bug above.
  Errors are now read from any argument position, which is how all three step
  packages call it.

### Changed

- **The session now defaults to the one `login` writes**, so "sign in on the
  host, then run this" works with no preparation. It used to default to
  `./output/auth.json` and fail with `no auth file` unless you knew to make a
  copy that no document mentioned.
- **The Docker section of the README** is written around a single mounted volume
  at `/data/output`, showing the copy step, the resulting directory tree, and the
  separate read-only mount as the alternative for keeping the session out of the
  notes directory.

Tests: 102 → 128. Verified by a real export: 18 notes written to
`./output/NotebookLongSimple`, `logs/app.log` beside them, one image downloaded.

### Release process

0.1.0 was published from a laptop, so it carries no provenance and this
repository had no tags or releases at all — which is why neither the tag-triggered
OIDC workflow nor a GitHub Release existed for it. From 0.1.1 the release is
`v0.1.1` pushed to `main`, so the workflow publishes with a provenance statement
attached.

## [0.1.0] - 2026-10-01

The first release. It adds a CLI over three existing packages and changes none of
their behaviour.

### Added

- **`microsoft-onenote-exporter <login|check|logout|list|export>`.** One binary over
  `@msout/microsoft-webauth`, `@msout/microsoft-onenote-list-notebooks` and
  `@msout/microsoft-onenote-export-notebook`, all three of which remain
  separately installable and separately tested. A typical first run is `login`,
  then `list`, then `export --notebook "Work"`.
- **A single Playwright, and therefore a single Chromium.** The three step
  packages each declared `playwright: ^1.58.1` behind their own lockfile, so npm
  resolved them independently — 1.61.0 in one, 1.61.1 in another — and each
  wanted a different Chromium revision. A machine with all three checkouts out
  held four revisions and 3.2 GB of browser. They are now pinned to exact versions
  with an `overrides` block forcing one `playwright` and `playwright-core` across
  the tree, and `test/wiring.test.js` fails if that ever stops being true.
- **One log per run.** Each package resolved its own log directory at load time,
  so a pipeline produced three `app.log` files in three directories. The
  environment variable those packages read is set before any of them is loaded,
  so all four loggers — this CLI's and the three steps' — write one file.
- **One Docker image** for all five commands, with one Chromium. It replaces
  three images that each carried their own browser; the list image also installed
  a distribution `chromium` from apt that nothing used. `start-container.sh`
  replaces the positional `<session-guid> <notebook-name>` interface with
  subcommands, waits for the run, and explains exit code 3 as a partial export
  rather than a failure.
- **Exit codes that mean something.** 0 success, 1 failure, 2 bad arguments, and
  3 for an export that finished while missing pages, sections or groups. The
  third is passed through from the export package's own `exitCodeForStats`, which
  is asked rather than reimplemented, so the two CLIs cannot disagree.

### Notes

- `login` cannot run headless without `--email` and `--password`, and the
  container refuses `login` outright rather than opening a browser nobody can see.
  Interactive sign-in happens on the host.
- `all`, which chains login → list → export in one invocation, is deliberately
  not in this release. None of the three packages accepts an injected browser, so
  it would still be three Chromium launches behind one command — and the change
  needed to make it one launch reaches into the most delicate file in the set.
