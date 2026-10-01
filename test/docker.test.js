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

    // Appending --auth-file unconditionally would override an explicit choice,
    // so the container would read a different session than the one asked for.
    it('only injects --auth-file when the caller did not pass one', () => {
        expect(entrypoint).toMatch(/for arg in "\$@"/);
        expect(entrypoint).toMatch(/\[ "\$arg" = "--auth-file" \]/);
    });

    it('points at the mounted volume by default', () => {
        expect(entrypoint).toMatch(/AUTH_FILE="\$\{AUTH_FILE:-\/data\/output\/auth\.json\}"/);
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
});
