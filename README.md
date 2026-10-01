# microsoft-onenote-exporter

One command for the whole Microsoft OneNote pipeline: sign in, list the notebooks
on the account, export one to Obsidian-flavoured Markdown.

This is an umbrella over three packages that remain separately installable and
separately tested:

| Step | Package |
|---|---|
| `login`, `check`, `logout` | [`@msout/microsoft-webauth`](https://github.com/Ms-OneNote-Exporter/microsoft-webauth) |
| `list` | [`@msout/microsoft-onenote-list-notebooks`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-list-notebooks) |
| `export` | [`@msout/microsoft-onenote-export-notebook`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook) |

Each one works on its own, and you can still install just the one you need. What
this adds is a single binary that can do all three, one Playwright install, one
Docker image, and one log per run.

## Why it exists

The three packages each declared `playwright: ^1.58.1` behind their own
lockfile, so npm resolved them independently — 1.61.0 in one, 1.61.1 in another.
Each resolved version wants a different Chromium revision, so a machine with all
three checkouts out downloads several browser builds into the shared
`~/Library/Caches/ms-playwright` cache. On the machine this was built on, that
cache held four Chromium revisions and weighed 3.2 GB.

It also let a single run produce three `app.log` files in three directories,
because each package resolved its own log path at load time.

Both problems are fixed at the root rather than papered over:

- the three dependencies are pinned to **exact** versions, and `overrides` forces
  a single `playwright` / `playwright-core` across the whole tree. A caret range
  always takes the newest match, so it is the wrong tool here;
- `ONENOTE_EXPORT_LOG_DIR` is set before any step package is loaded, so all four
  loggers write one `app.log`.

There is a test for each: `test/wiring.test.js` fails if more than one Playwright
is installed, or if the pins drift back to a range.

## Install

```sh
npm install -g @msout/microsoft-onenote-exporter
npx playwright install chromium
```

The Chromium download is separate from `npm install` and is required — without it
every command that opens a browser fails.

Two command names are installed, pointing at the same binary:

```sh
microsoft-onenote-exporter login    # matches the package and repository name
ms-onenote-exporter login           # shorter, for typing
```

Everything below uses the long one.

## Use

```sh
microsoft-onenote-exporter login                              # opens a browser; sign in there
microsoft-onenote-exporter list                               # what is on the account
microsoft-onenote-exporter export --notebook "Work"           # export one
```

That is the whole pipeline. The session written by `login` is picked up by
`list` and `export` automatically.

### Commands

| Command | What it does |
|---|---|
| `login` | Signs in and saves the session. Without `--email`/`--password` the browser opens and you sign in yourself — an interactive login cannot run headless. |
| `check` | Reports whether the saved session is still valid. A dead session is deleted, so the next command needs a fresh `login`. |
| `logout` | Deletes the saved session and its metadata. |
| `list` | Lists the notebooks on the account. An empty result is a success, not an error. |
| `export` | Exports one notebook to Markdown. |

### Options

Every command accepts `--auth-file`, `--notheadless`, `--dodump`, `--verbose` and
`--quiet`.

| Command | Additional options |
|---|---|
| `login` | `--email`, `--password`, `--against onenote\|outlook`, `--screenshot` |
| `check` | `--against onenote\|outlook` |
| `export` | `--notebook <name>`, `--notebook-link <url>`, `--output-dir <path>`, `--nopassasked`, `--non-interactive` |

`--screenshot` only means something together with `--dodump`, so asking for one
turns the other on and says so.

### Unattended use

`--non-interactive` is for containers and CI. It requires `--notebook` or
`--notebook-link`, and implies `--nopassasked`, so the run cannot stop at a prompt
nobody is there to answer:

```sh
microsoft-onenote-exporter export --notebook "Work" --non-interactive --output-dir ./out
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | The command failed — unusable auth file, dead run. |
| 2 | The arguments were wrong. |
| 3 | The export finished, but pages, sections or groups are missing. |

Three is deliberately not an error: the notes that were written are complete and
name any asset they could not download, so the output is worth keeping and
re-running is worth doing. It comes from
`@msout/microsoft-onenote-export-notebook`'s own rule, which this CLI asks for
rather than reimplementing.

## Logs

Every step of a run — this CLI's messages and all three packages' — goes to one
`logs/app.log` under the working directory. Override it with
`ONENOTE_EXPORT_LOG_DIR`, or use `--dodump` to also write the HTML of each page.

The directory and the log file are created owner-only. Dumps hold the
authenticated DOM of a real account: cookies, tenant hostnames, note titles.

## Docker

One image, one Chromium, serving all five commands. It replaces the three separate
images these packages used to ship, each carrying its own browser.

```sh
docker build -t microsoft-onenote-exporter .
```

### Mounting

The container reads and writes through a single volume mounted at
`/data/output`. The host directory of your choice — `./output` below — receives
the exported notes *and* provides the saved session:

```
host ./output  ->  /data/output
```

A login cannot happen inside the container: without credentials the browser has
to be shown, and there is nobody there to show it to. So you sign in on the host
first, put the session in the mount, and the container reads it from there:

```sh
# 1. sign in on the host, once
microsoft-onenote-exporter login

# 2. put the session where the container can see it
mkdir -p output
cp ~/.microsoft-webauth/auth-file.json output/auth.json

# 3. export, writing notes back into ./output
docker run --rm --init --shm-size=1g \
  -v "$PWD/output:/data/output" \
  microsoft-onenote-exporter export \
    --notebook "NotebookLongSimple" \
    --non-interactive
```

That produces:

```
output/
├── auth.json                    the session (a live credential - see below)
├── logs/app.log                 every step of the run, in order
└── NotebookLongSimple/
    ├── Section1/
    │   ├── Section1-Note1.md
    │   └── Section1-Note2w2Pic.md
    └── Section2/assets/         images and attachments, beside the notes
```

Two flags are required and are easy to leave out:

- **`--shm-size=1g`** — Chromium crashes on memory-heavy pages with Docker's
  default 64 MB of shared memory.
- **`--init`** — reaps Chromium's child processes instead of leaving zombies.

If you omit the `-v` mount, the entrypoint warns you: the notes would be written
inside the container and lost when it exits. That is not a hypothetical — it is
what happens by default, because the CLI's own default for `--output-dir` is
`./output` relative to a working directory of `/app`, which exists and is
writable, so the export succeeds and the files vanish. Whenever a volume is
mounted, the entrypoint points `--output-dir` at it.

`output/auth.json` is a full account credential. Keep the directory out of git —
`.gitignore` covers `output/` — and be careful with anything that syncs it whole,
such as a cloud backup or an Obsidian vault. If you would rather keep the session
out of the notes directory, mount it separately instead:

```sh
docker run --rm --init --shm-size=1g \
  -v "$PWD/output:/data/output" \
  -v "$HOME/.microsoft-webauth/auth-file.json:/data/auth/session.json:ro" \
  microsoft-onenote-exporter export \
    --notebook "NotebookLongSimple" --non-interactive \
    --auth-file /data/auth/session.json
```

### The wrapper

`start-container.sh` does the mounting, waits for the run, and translates the
exit code into an explanation:

```sh
cp ~/.microsoft-webauth/auth-file.json ./output/auth.json   # once
./start-container.sh --notebook "NotebookLongSimple"
```

It defaults `OUTPUT_DIR` to `./output`, so that is where the notes and
`logs/app.log` land. If `./output/auth.json` is absent it falls back to the
session in `~/.microsoft-webauth`, mounting that read-only instead — so it works
either way.

```sh
CONTAINER=other-name ./start-container.sh --notebook "Work"   # rename the container
IMAGE=my-registry/microsoft-onenote-exporter ./start-container.sh --notebook "Work"
```

The wrapper runs detached and reports the container's exit status. It removes the
container it created, so it can be run repeatedly; if one is still running it
says so rather than colliding with it.

## Development

The three step packages are pinned to versions that must exist on npm. To work
against local checkouts before they are published:

```sh
npm run use:local      # pack the sibling repos and install those
npm test
npm run use:published  # go back to the registry copies
```

`use:local` expects the three repositories one directory up, and leaves
`package.json` pinning published versions — only `node_modules` differs, so a
`file:` spec can never be committed.

```sh
npm test        # no browser and no account needed
npm run lint
```

### Release order

There is an ordering constraint, and it is the one thing that cannot be worked
around: **this package cannot have a committed `package-lock.json` until the
three step packages are on npm.** Their pinned versions do not resolve before
then, and `use:local` produces a lockfile full of `file:.local-tarballs/…`
entries that works only on the machine that made it — `.local-tarballs/` is
gitignored, so CI and the Docker image would both fail to install from it.

So the first release goes:

1. Publish the three step packages from their own repositories.
2. Here: `rm -rf node_modules .local-tarballs && npm install`.
3. Commit the generated `package-lock.json`. After this, `npm ci` works and CI
   and the Dockerfile function.

`test/lockfile.test.js` fails with these instructions until step 3 happens, so the
gap is visible rather than discovered during a build.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
