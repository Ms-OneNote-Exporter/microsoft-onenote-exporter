/**
 * Guards the lockfile.
 *
 * This package depends on three sibling packages that are pinned to versions
 * which only exist on npm once they are published. That creates a real ordering
 * constraint, and this test is how it stays visible rather than becoming a
 * surprise during a Docker build.
 *
 * The failure mode it prevents: `npm run use:local` installs the three step
 * packages from `.local-tarballs/`, which produces a lockfile full of
 * `file:.local-tarballs/...` entries. That lockfile works on the machine that
 * made it and nowhere else - `.local-tarballs/` is gitignored, so CI and the
 * Docker image would both fail to install. Committing it would break every build
 * while leaving `npm test` green locally.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCKFILE = path.join(ROOT, 'package-lock.json');

const RELEASE_ORDER = [
    '1. Publish the three step packages, from their own repositories:',
    '     cd ../microsoft-webauth                 && npm publish',
    '     cd ../microsoft-onenote-list-notebooks  && npm publish',
    '     cd ../microsoft-onenote-export-notebook && npm publish',
    '2. Then, here:',
    '     rm -rf node_modules .local-tarballs',
    '     npm install          # resolves the published versions',
    '3. Commit the generated package-lock.json.',
].join('\n');

describe('package-lock.json', () => {
    it('exists, and can therefore be installed with npm ci', () => {
        if (!fs.existsSync(LOCKFILE)) {
            // npm ci, and so CI and the Dockerfile, cannot run without it. The
            // message matters more than the assertion: the fix is a publish
            // order, not a code change.
            throw new Error(
                'package-lock.json is missing.\n\n' +
                    'It cannot be generated until the three step packages are on npm, because\n' +
                    'their pinned versions do not resolve yet. `npm run use:local` produces a\n' +
                    'lockfile full of file:.local-tarballs entries, which works only on this\n' +
                    'machine and must not be committed.\n\n' +
                    RELEASE_ORDER
            );
        }
        expect(fs.existsSync(LOCKFILE)).toBe(true);
    });

    it('resolves every step package from the registry, not from a local tarball', () => {
        if (!fs.existsSync(LOCKFILE)) return; // the test above reports this properly

        const lock = require(LOCKFILE);
        const entries = Object.entries(lock.packages || {}).filter(([key]) => key.includes('@msout/'));

        expect(entries.length).toBeGreaterThan(0);

        for (const [key, value] of entries) {
            expect({ key, resolved: value.resolved })
                .toEqual({ key, resolved: expect.stringContaining('https://registry.npmjs.org/') });
        }
    });

    it('resolves playwright to the pinned version from the registry', () => {
        if (!fs.existsSync(LOCKFILE)) return;

        const lock = require(LOCKFILE);
        const entry = lock.packages['node_modules/playwright'];
        expect(entry).toBeDefined();
        expect(entry.version).toBe(require('../package.json').overrides.playwright);
    });
});

describe('the step package pins', () => {
    const pkg = require('../package.json');

    // A caret range is what caused the drift in the first place: npm resolves it
    // to the newest matching 1.x, independently in each of the three repos, so
    // the three end up on different Chromium revisions.
    it.each([
        '@msout/microsoft-webauth',
        '@msout/microsoft-onenote-list-notebooks',
        '@msout/microsoft-onenote-export-notebook',
    ])('%s is pinned exactly, not by a range', (name) => {
        expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('overrides collapse playwright to one version across the whole tree', () => {
        expect(pkg.overrides.playwright).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkg.overrides['playwright-core']).toBe(pkg.overrides.playwright);
    });

    // An override only applies to the root project, which is exactly where this
    // is: the three packages are consumers here, so a caret inside one of them
    // is harmless as long as this file collapses the tree.
    it('declares playwright directly as well, so the pin is visible', () => {
        expect(pkg.dependencies.playwright).toBe(pkg.overrides.playwright);
    });
});
