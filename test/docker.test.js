const fs = require('fs');
const path = require('path');

/**
 * Static assertions over the Docker build inputs.
 *
 * CI has no Docker daemon, so these cannot build the image. They exist to catch
 * the specific regressions that matter here, all of which are invisible until
 * someone builds and runs it: a floating base tag, a `git clone` in place of a
 * COPY, and a .dockerignore that would sweep a live auth.json into a layer.
 */
const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const entrypoint = read('entrypoint.sh');
const startScript = read('start-container.sh');

/** All RUN/COPY/ENV/etc. instructions, in order, comments stripped. */
const instructions = () =>
    dockerfile
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

/** The instructions joined, for assertions about what is absent. */
const code = () => instructions().join('\n');

describe('Dockerfile', () => {
    it('pins the base image to a patch release', () => {
        const from = instructions().find((l) => l.startsWith('FROM '));
        expect(from).toBeDefined();
        // A floating tag like `node:24-slim` floats; a patch tag does not. The
        // pattern is version-agnostic so a Node bump does not have to touch this.
        expect(from).toMatch(/^FROM node:\d+\.\d+\.\d+-\w+-slim$/);
    });

    it('uses npm ci so the lockfile is authoritative', () => {
        expect(code()).toMatch(/^RUN npm ci$/m);
        // `npm install` would rewrite the lockfile inside the image.
        expect(code()).not.toMatch(/^RUN npm install/m);
    });

    it('copies the source in rather than fetching it at build time', () => {
        expect(code()).toMatch(/^COPY src\/\s+\.\/src\/$/m);
        expect(code()).not.toMatch(/git\s+clone/);
    });

    it('does not install git at all', () => {
        for (const line of instructions().filter((l) => l.includes('apt-get install'))) {
            expect(line).not.toMatch(/\bgit\b/);
        }
    });

    // The reason this image exists. Three images each ran their own
    // `playwright install chromium`; one image must run it once.
    it('installs the Chromium system dependencies and the browser exactly once', () => {
        expect(code()).toMatch(/npx playwright install-deps chromium/);
        const installs = instructions().filter((l) => /^RUN npx playwright install chromium$/.test(l));
        expect(installs).toHaveLength(1);
    });

    // microsoft-onenote-list-notebooks' old image installed a distribution
    // `chromium` from apt as well as Playwright's own: a second browser in the
    // same image that nothing ever used.
    it('does not install a second browser from the distribution', () => {
        for (const line of instructions().filter((l) => l.includes('apt-get install'))) {
            expect(line).not.toMatch(/\bchromium\b/);
        }
    });

    it('installs the browser for the runtime user, in a writable cache', () => {
        expect(code()).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=\/home\/node\/\.cache\/ms-playwright$/m);
        // The browser layer must come after dropping to USER node, or the cache
        // is written as root and stays unusable once privileges are dropped -
        // which shows up as a browser that will not launch, not as a build error.
        const lines = instructions();
        const firstNode = lines.findIndex((l) => l === 'USER node');
        const install = lines.findIndex((l) => /^RUN npx playwright install chromium$/.test(l));
        expect(firstNode).toBeGreaterThanOrEqual(0);
        expect(install).toBeGreaterThan(firstNode);
    });

    it('runs as an unprivileged user', () => {
        const users = instructions().filter((l) => l.startsWith('USER '));
        expect(users.length).toBeGreaterThan(0);
        // The final USER decides the runtime identity.
        expect(users[users.length - 1]).toBe('USER node');
    });

    // Otherwise the four loggers throw on startup for a non-root user: the
    // umbrella's own, and each step package's, because all four write to one
    // directory under /app.
    it('makes the log and output directories writable by that user', () => {
        expect(code()).toMatch(/mkdir -p \/app\/logs \/app\/output/);
        expect(code()).toMatch(/chown -R node:node \/app\/logs \/app\/output/);
    });

    it('starts the local entrypoint', () => {
        expect(code()).toMatch(/^ENTRYPOINT \["\/app\/entrypoint\.sh"\]$/m);
    });

    it('mentions the shm-size requirement somewhere, since it is a run flag', () => {
        // --shm-size cannot be set in the image; it has to be documented here or
        // passed by start-container.sh, or Chromium crashes on memory-heavy pages.
        expect(dockerfile).toMatch(/--shm-size/);
    });
});

describe('.dockerignore', () => {
    it('excludes the host node_modules', () => {
        // The one that matters most: a local node_modules would replace the
        // pinned dependency tree, which is what guarantees one Playwright.
        expect(dockerignore).toMatch(/^node_modules\/$/m);
    });

    it('excludes the local package tarballs', () => {
        expect(dockerignore).toMatch(/^\.local-tarballs\/$/m);
    });

    // .gitignore keeps auth.json out of git, but a `COPY . .` would still put a
    // full-account credential in a layer, readable by anyone who can pull the
    // image, forever.
    it('excludes authentication state', () => {
        expect(dockerignore).toMatch(/^auth\.json$/m);
        expect(dockerignore).toMatch(/^\*auth\*json$/m);
    });

    it.each(['output/', 'logs/', 'dumps/', 'diag-dumps/', 'coverage/'])('excludes %s', (dir) => {
        expect(dockerignore).toMatch(new RegExp(`^${dir.replace('/', '\\/')}$`, 'm'));
    });

    it('excludes the git directory', () => {
        expect(dockerignore).toMatch(/^\.git\/$/m);
    });

    it('still allows the files the image needs', () => {
        expect(dockerignore).not.toMatch(/^src\/$/m);
        expect(dockerignore).not.toMatch(/^package\.json$/m);
        expect(dockerignore).not.toMatch(/^entrypoint\.sh$/m);
        expect(dockerignore).not.toMatch(/^Dockerfile$/m);
    });
});

describe('entrypoint.sh', () => {
    it('is executable and has a shell shebang', () => {
        expect(entrypoint.startsWith('#!/bin/sh')).toBe(true);
        // Checked in the repository because a wrong mode here is a container
        // that fails to start with a confusing error.
        const mode = fs.statSync(path.join(ROOT, 'entrypoint.sh')).mode;
        expect(mode & 0o111).toBeGreaterThan(0);
    });

    it('prints usage and exits 0 with no arguments', () => {
        expect(entrypoint).toMatch(/if \[ \$# -eq 0 \]/);
        expect(entrypoint).toMatch(/exit 0/);
    });

    // A login cannot run headless: without credentials the browser has to be
    // shown, and there is nobody in a container to type into it. Failing with an
    // explanation beats a browser that opens onto nothing.
    it('refuses login, and says what to do instead', () => {
        expect(entrypoint).toMatch(/case "\$1" in\s*\n\s*login\)/);
        expect(entrypoint).toMatch(/host/);
        expect(entrypoint).toMatch(/exit 2/);
    });

    it('passes a shell through for debugging', () => {
        expect(entrypoint).toMatch(/exec "\$@"/);
    });

    // This one shipped broken. The passthrough ran `exec node "$@"` with $@ still
    // holding "node", so it executed `node node <script>`. Node reads the first
    // argument as a module path, so both documented debugging routes died with
    // MODULE_NOT_FOUND:
    //
    //   docker run --rm microsoft-onenote-exporter node --version
    //   docker run --rm microsoft-onenote-exporter node /app/src/index.js list
    //
    // Static assertions missed it because `exec node "$@"` looks correct; only
    // running the built image surfaced it.
    it('shifts the node passthrough so it does not pass "node" twice', () => {
        expect(entrypoint).toMatch(/if \[ "\$1" = "node" \]; then\s*\n\s*shift\s*\n\s*exec node "\$@"/);
    });

    // Appending --auth-file unconditionally would override an explicit choice,
    // so the container would read a different session than the one asked for.
    it('only injects --auth-file when the caller did not pass one', () => {
        expect(entrypoint).toMatch(/for arg in "\$@"/);
        expect(entrypoint).toMatch(/\[ "\$arg" = "--auth-file" \]/);
    });

    it('points at the mounted volume by default', () => {
        expect(entrypoint).toMatch(/AUTH_FILE="\$\{AUTH_FILE:-\/data\/output\/auth\.json\}"/);
    });

    // The container's working directory is /app, so the CLI's own default for
    // --output-dir - ./output against the cwd - resolves to /app/output. That
    // directory exists and is writable, so the export succeeded, reported
    // "Files saved in: /app/output/<notebook>" and lost everything when the
    // container exited: /app/output is inside the image, not the mounted volume.
    // Found only by running a real export and looking for the notes on the host.
    it('points --output-dir at the mounted volume when there is one', () => {
        expect(entrypoint).toMatch(/--output-dir \/data\/output/);
    });

    it('warns when no volume is mounted, since the notes would be lost', () => {
        expect(entrypoint).toMatch(/WARNING: no volume is mounted/);
    });

    // An explicit --output-dir has to win, or the run goes somewhere the caller
    // did not ask for.
    it('injects --output-dir only when the caller did not pass one', () => {
        expect(entrypoint).toMatch(/has_output_dir=false/);
        expect(entrypoint).toMatch(/\[ "\$arg" = "--output-dir" \]/);
    });

    // The bug. --output-dir was appended for every subcommand, so `list`, `check`
    // and `logout` - none of which define that option - all died with
    //
    //   error: unknown option '--output-dir'
    //
    // and the flag in question had been added by the entrypoint itself. `export`
    // kept working, because it is the only subcommand anyone had run through a
    // container, and 130 tests passed throughout.
    //
    // Asserted as structure rather than as text, because the previous assertion
    // above passed against the broken version: it checked that the injection
    // existed, not which subcommands it applied to.
    it('offers --output-dir only to export', () => {
        // The gate that decides.
        expect(entrypoint).toMatch(/if \[ "\$arg" = "export" \]; then/);
        expect(entrypoint).toMatch(/is_export=true/);

        // And the injection is inside that gate, not after it. Comparing the two
        // positions is what makes this fail if someone un-scopes it again.
        const gate = entrypoint.indexOf('if [ "$is_export" = true ]; then');
        const inject = entrypoint.indexOf('set -- "$@" --output-dir /data/output');
        expect(gate).toBeGreaterThan(-1);
        expect(inject).toBeGreaterThan(-1);
        expect({ injectIsInsideExportGate: inject > gate }).toEqual({ injectIsInsideExportGate: true });
    });

    // A named subcommand is how the entrypoint recognises export. If the CLI ever
    // took it as a flag instead, this would silently stop matching and the notes
    // would go back to /app/output - the failure that started all this.
    it('matches the export subcommand by name, as the CLI takes it', () => {
        expect(entrypoint).toMatch(/case "\$1" in\s*\n\s*login\)/);
        expect(entrypoint).toMatch(/\[ "\$arg" = "export" \]/);
    });
});

describe('start-container.sh', () => {
    it('is executable and has a bash shebang', () => {
        expect(startScript.startsWith('#!/bin/bash')).toBe(true);
        const mode = fs.statSync(path.join(ROOT, 'start-container.sh')).mode;
        expect(mode & 0o111).toBeGreaterThan(0);
    });

    // Chromium crashes on the default 64 MB of shared memory, and its children
    // become zombies without a reaper.
    it('passes --shm-size and --init to docker run', () => {
        expect(startScript).toMatch(/--shm-size=1g/);
        expect(startScript).toMatch(/--init/);
    });

    it('mounts the output directory at the path the entrypoint expects', () => {
        expect(startScript).toMatch(/-v "\$\{OUTPUT_DIR_ABS\}:\/data\/output"/);
    });

    it('fails before starting if the auth file is missing', () => {
        // Docker would create a directory for a missing mount source, and the
        // failure would surface inside the container as an opaque storage-state
        // error instead of an obvious message here.
        expect(startScript).toMatch(/if \[ ! -f "\$AUTH_FILE" \]/);
        expect(startScript).toMatch(/no auth file at/);
    });

    it('fails before starting if the image is not built', () => {
        expect(startScript).toMatch(/docker image inspect/);
    });

    it('propagates the container exit status', () => {
        expect(startScript).toMatch(/EXIT_CODE="\$\(docker wait "\$CONTAINER"\)"/);
        expect(startScript).toMatch(/exit "\$EXIT_CODE"/);
    });

    // 3 is not a failure worth discarding output over: the notes that were
    // written are good and the run says which assets are missing.
    it('explains exit code 3 as a partial export, not a failed one', () => {
        expect(startScript).toMatch(/3\)/);
        expect(startScript).toMatch(/missing/);
    });

    it('keeps whatever was written, whatever the status', () => {
        expect(startScript).toMatch(/has been kept/);
    });

    // The documented primary path: the session lives in ./output, which is
    // already the mounted volume, so there is nothing else to mount. But that
    // leaves the optional-mount array empty, and expanding an empty array as
    // "${AUTH_MOUNT[@]}" under `set -u` is an error on some bash builds. The
    // wrapper died with
    //
    //   line 222: AUTH_MOUNT[@]: unbound variable
    //
    // before starting any container - so the way the README tells people to run
    // an export could not run, while the fallback path worked and hid it.
    it('survives an empty optional-mount array', () => {
        expect(startScript).toMatch(/AUTH_MOUNT=\(\)/);
        expect(startScript).toMatch(/\$\{AUTH_MOUNT\[@\]\+"\$\{AUTH_MOUNT\[@\]\}"\}/);
        // The unguarded form must not still be there.
        expect(startScript).not.toMatch(/^\s*"\$\{AUTH_MOUNT\[@\]\}" \\$/m);
    });

    // The wrapper forwarded flags verbatim and never supplied the subcommand, so
    // the container received only `--notebook <name>` and commander answered
    // "unknown option '--notebook'" - the subcommand has to precede the flags.
    it('supplies the subcommand, defaulting to export', () => {
        expect(startScript).toMatch(/SUBCOMMAND="\$\{1:-\}"/);
        expect(startScript).toMatch(/SUBCOMMAND="export"/);
        expect(startScript).toMatch(/"\$SUBCOMMAND" "\$@"/);
    });

    // Issue #3. `list`, `check` and `logout` need no arguments at all, and an
    // unscoped `$# -eq 0` guard rejected all three:
    //
    //   $ ./start-container.sh list
    //   Usage: ./start-container.sh <list> [options...]
    //
    // Two guards did this, and only one was meant to. The export-scoped one is
    // correct; the bare one was not, and is gone.
    //
    // Asserted structurally - that no `$# -eq 0` test exists outside an export
    // guard - because the previous assertion in this file passed against the
    // broken script: it checked that a subcommand was supplied, not that the
    // wrapper then accepted a bare one.
    it('does not require arguments for the steps that need none', () => {
        // Match the whole `if` line rather than one bracket group: a condition
        // like [ "$SUBCOMMAND" = "export" ] && [ $# -eq 0 ] contains a `]` before
        // the `$#`, so a pattern anchored on `[ ... ]` finds nothing. That was
        // the first version of this test, and it passed vacuously against a
        // script with no guard at all - which is the failure mode it exists to
        // prevent.
        const guards = [...startScript.matchAll(/^\s*if\s+(\[.*\$#\s*-eq\s*0.*\])\s*; then/gm)];
        expect(guards.length).toBeGreaterThan(0);

        for (const guard of guards) {
            // Every remaining argument-count guard must be scoped to export.
            expect({ guard: guard[1], scopedToExport: /SUBCOMMAND" = "export"/.test(guard[1]) })
                .toEqual({ guard: guard[1], scopedToExport: true });
        }
    });

    it('still refuses a bare export, which cannot choose a notebook', () => {
        // The guard that should have been the only one.
        expect(startScript).toMatch(/if \[ "\$SUBCOMMAND" = "export" \] && \[ \$# -eq 0 \]; then/);
    });

    // It has to say the same thing it runs: this line used to print
    // "microsoft-onenote-exporter --notebook X", omitting the subcommand the
    // invocation adds, so the most reassuring line in the script described a
    // command that was never executed.
    it('echoes the command it actually runs', () => {
        // Matched loosely on purpose: the exact tail is allowed to change, but the
        // subcommand must be named, since omitting it is what made the line a lie.
        expect(startScript).toMatch(/echo "Running: microsoft-onenote-exporter \$SUBCOMMAND /);
    });

    // Prefers ./output/auth.json over ~/.microsoft-webauth. It has to check
    // explicitly: with the default set to ~/.microsoft-webauth, the script looks
    // for a file named `auth-file.json` in the output directory and silently
    // ignores the `auth.json` the README tells people to put there.
    it('prefers ./output/auth.json, then falls back to ~/.microsoft-webauth', () => {
        expect(startScript).toMatch(/if \[ -f "\$\{OUTPUT_DIR\}\/auth\.json" \]/);
        expect(startScript).toMatch(/AUTH_FILE="\$HOME\/\.microsoft-webauth\/auth-file\.json"/);
    });

    // `docker wait` blocks until the container stops. A poll loop over
    // `docker inspect -f {{.State.ExitCode}}` exits on its first iteration,
    // because that field is 0 while the container is still running - so the
    // wrapper reported "Exported files are in: ..." for an export that had not
    // written a single file.
    it('waits with docker wait rather than polling the exit code', () => {
        expect(startScript).toMatch(/EXIT_CODE="\$\(docker wait "\$CONTAINER"\)"/);
        // `State.ExitCode` may appear in the comment explaining the trap, but
        // never as a value the script reads.
        expect(startScript).not.toMatch(/docker inspect -f '\{\{\.State\.ExitCode\}\}'/);
    });

    // The container name is derived from the working directory, so it repeats
    // across runs and Docker refuses to reuse it. Without removing the leftover,
    // the wrapper only ever worked once per machine.
    it('removes the container it created, and refuses if one is running', () => {
        expect(startScript).toMatch(/docker rm "\$CONTAINER"/);
        expect(startScript).toMatch(/is already running/);
    });

    // app.log is the only record of what an export did. Without the mount it died
    // with the container, and the wrapper's own "see logs/app.log" advice pointed
    // at a path that never existed on the host.
    it('mounts the log directory inside the output volume', () => {
        expect(startScript).toMatch(/ONENOTE_EXPORT_LOG_DIR=\/data\/output\/logs/);
        expect(startScript).toMatch(/-e ONENOTE_EXPORT_LOG_DIR=/);
    });

    // logout deletes the session - that is all it does - so mounting it read-only
    // made the subcommand impossible:
    //
    //   EACCES: permission denied, unlink '/data/auth/session.json'
    //
    // Read-only stays the default for every other step, since a bug in the
    // container should not be able to destroy a live full-account session.
    // logout cannot be done in the container at all: Docker mounts a single file
    // at /data/auth/session.json, and a container cannot remove a mount point, so
    // unlinking it failed with EACCES whether the mount was read-only or not.
    // Deleting a session is a host-side operation, so the script does it and
    // exits before requiring an image at all.
    it('does logout on the host, without a container', () => {
        expect(startScript).toMatch(/if \[ "\$SUBCOMMAND" = "logout" \]; then\s*\n\s*if \[ ! -f "\$AUTH_FILE" \]/);
        expect(startScript).toMatch(/rm -f "\$AUTH_FILE"/);
        // The metadata webauth writes beside the session goes too.
        expect(startScript).toMatch(/META_FILE="\$\{AUTH_FILE%\.json\}-meta\.json"/);
        expect(startScript).toMatch(/rm -f "\$META_FILE"/);
    });

    // The flag was silently ignored: the wrapper picks the session itself and
    // passes its own --auth-file to the container, so a caller's
    // `--auth-file ./my.json` was neither honoured nor rejected. Found by passing
    // the flag, watching a different file get deleted, and reading the code.
    it('honours --auth-file from the command line, and prefers it', () => {
        expect(startScript).toMatch(/AUTH_FILE_FROM_ARGS/);
        expect(startScript).toMatch(/\[ "\$prev" = "--auth-file" \]/);
        expect(startScript).toMatch(/--auth-file=\*/);
        // Highest precedence, before the env var and both defaults. Matched on the
        // assignments rather than the bare path, because the comment above them
        // documents the same order and would match first.
        const branch = startScript.indexOf('if [ -n "$AUTH_FILE_FROM_ARGS" ]; then');
        const envBranch = startScript.indexOf('elif [ -n "${AUTH_FILE:-}" ]; then');
        const fallback = startScript.indexOf('AUTH_FILE="$HOME/.microsoft-webauth/auth-file.json"');
        expect(branch).toBeGreaterThan(-1);
        expect(envBranch).toBeGreaterThan(-1);
        expect(fallback).toBeGreaterThan(-1);
        expect(branch).toBeLessThan(envBranch);
        expect(envBranch).toBeLessThan(fallback);
    });

    // The exit-code messages named "the export" unconditionally, so a failed
    // logout said "the export failed and produced nothing usable" and pointed at
    // notes that were never the point of the command.
    it('names the subcommand in its failure messages', () => {
        expect(startScript).toMatch(/WARNING: \$SUBCOMMAND failed\./);
        expect(startScript).toMatch(/echo "\$SUBCOMMAND finished\."/);
        // "Exported files are in:" is export-specific and stays behind a check,
        // since three of the five steps write no notes at all.
        expect(startScript).toMatch(/\[ "\$SUBCOMMAND" = "export" \]; then\s*\n\s*echo "Exported files are in:/);
    });

    it('defaults OUTPUT_DIR to ./output, where the README says notes land', () => {
        expect(startScript).toMatch(/OUTPUT_DIR="\$\{OUTPUT_DIR:-\.\/output\}"/);
    });
});
