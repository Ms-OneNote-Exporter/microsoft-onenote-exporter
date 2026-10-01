# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
