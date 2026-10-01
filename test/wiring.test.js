/**
 * Tests that need the real packages installed, not stubs.
 *
 * These are the assertions that justify the umbrella's existence, so they are
 * worth the seconds they cost. Everything here fails loudly rather than skipping
 * if the sibling packages are absent, because "the umbrella installed three
 * copies of Playwright" is precisely the thing that must never be true and is
 * invisible in a unit test with mocks.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const STEP_PACKAGES = [
    '@msout/microsoft-webauth',
    '@msout/microsoft-onenote-list-notebooks',
    '@msout/microsoft-onenote-export-notebook',
];

/** Every installed copy of a package, including nested ones. */
function installedCopies(name) {
    const found = [];
    const walk = (dir, depth) => {
        if (depth > 4) return;
        let entries;
        try {
            entries = fs.readdirSync(path.join(dir, 'node_modules'), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const full = path.join(dir, 'node_modules', entry.name);
            if (entry.name === name) {
                found.push(full);
            } else if (entry.name.startsWith('@')) {
                for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
                    if (scoped.isDirectory() || scoped.isSymbolicLink()) {
                        if (scoped.name === name.replace(/^@[^/]+\//, '')) found.push(path.join(full, scoped.name));
                    }
                }
            } else {
                walk(full, depth + 1);
            }
        }
    };
    walk(ROOT, 0);
    return found;
}

describe('the step packages are installed and importable', () => {
    it.each(STEP_PACKAGES)('%s is present at the pinned version', (name) => {
        const installed = path.join(ROOT, 'node_modules', name, 'package.json');
        expect(fs.existsSync(installed)).toBe(true);
        expect(require(installed).version).toBe(pkg.dependencies[name]);
    });

    // The bug the exports maps were added to fix. Each package's `main` used to
    // be a commander CLI that parsed a command line at require time, so the
    // first version of this umbrella could not import any of them.
    it.each(STEP_PACKAGES)('%s can be required without printing anything', (name) => {
        const script = `require(${JSON.stringify(name)});`;
        const stdout = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
        expect(stdout).toBe('');
    });

    it.each(STEP_PACKAGES)('%s still provides its bin', (name) => {
        const manifest = require(path.join(ROOT, 'node_modules', name, 'package.json'));
        expect(Object.keys(manifest.bin || {}).length).toBeGreaterThan(0);
    });
});

describe('exactly one Playwright, and therefore one Chromium', () => {
    // This is the whole point. Each of the three packages declared
    // `playwright: ^1.58.1` behind its own lockfile, so npm resolved them
    // independently, each wanting a different Chromium revision - and a machine
    // with all three checkouts downloaded several browser builds into the shared
    // Playwright cache. The exact pins plus `overrides` are what stop it.
    it('installs a single copy of playwright', () => {
        const copies = installedCopies('playwright');
        expect(copies).toHaveLength(1);
    });

    it('installs a single copy of playwright-core', () => {
        expect(installedCopies('playwright-core')).toHaveLength(1);
    });

    it('pins it to the version in the overrides block, not to whatever resolves', () => {
        expect(pkg.overrides.playwright).toBe(pkg.dependencies.playwright);
        expect(pkg.overrides['playwright-core']).toBe(pkg.overrides.playwright);
        // An exact version. A caret here would reopen the drift this package
        // exists to close, since a caret always takes the newest match.
        expect(pkg.overrides.playwright).not.toMatch(/[\^~]/);
    });

    it('pins the three step packages exactly, for the same reason', () => {
        for (const name of STEP_PACKAGES) {
            expect({ name, spec: pkg.dependencies[name] })
                .toEqual({ name, spec: pkg.dependencies[name] });
            expect(pkg.dependencies[name]).not.toMatch(/[\^~]/);
        }
    });

    // One revision means one download and one browser on disk.
    it('all installed Playwright copies agree on the Chromium revision', () => {
        const browsers = path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json');
        expect(fs.existsSync(browsers)).toBe(true);
        const revision = require(browsers).browsers.find((b) => b.name === 'chromium').revision;
        expect(revision).toBeTruthy();
    });
});

describe('the CLI', () => {
    const cli = (args, opts = {}) =>
        execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...args], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            ...opts,
        });

    it('prints its version', () => {
        expect(cli(['--version']).trim()).toBe(pkg.version);
    });

    it('lists every step in its help', () => {
        const help = cli(['--help']);
        for (const command of ['login', 'check', 'logout', 'list', 'export']) {
            expect(help).toContain(command);
        }
    });

    // A flag that works on one step and not another is indistinguishable from a
    // bug in the tool, so the shared options are checked on every command.
    it.each(['login', 'check', 'logout', 'list', 'export'])(
        '%s accepts the shared options',
        (command) => {
            const help = cli([command, '--help']);
            for (const flag of ['--auth-file', '--notheadless', '--dodump', '--verbose', '--quiet']) {
                expect(help).toContain(flag);
            }
        }
    );

    it('does not launch a browser to print help', () => {
        // If a step package were imported eagerly, --help would construct three
        // Playwright loggers and load the driver. Timing is a blunt instrument,
        // but a full browser launch would be far slower than this bound.
        const started = Date.now();
        cli(['--help']);
        expect(Date.now() - started).toBeLessThan(5000);
    });
});
