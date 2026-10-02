/**
 * Guards the publish settings.
 *
 * `publishConfig.access` is here because of a real failed publish. This package
 * is scoped (@msout/...), and npm defaults *scoped* packages to `restricted`
 * access, which is the paid feature. An unscoped package would have defaulted to
 * public and published fine - the scope is the only reason it can fail.
 *
 * With access left undeclared, `npm publish` on this package failed with:
 *
 *     npm error code E402
 *     npm error 402 Payment Required - You must sign up for private packages
 *
 * which reads as "you need to pay", but is npm asking to bill for a *private*
 * package that was never what this one is meant to be. Publishing it publicly is
 * free; the account needed no plan and nothing was charged.
 *
 * So this is asserted rather than assumed. It is two lines of manifest that
 * otherwise fail silently until somebody attempts a release.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');

describe('publishConfig', () => {
    it('declares the package public, so npm does not default it to restricted', () => {
        expect(pkg.publishConfig).toBeDefined();
        expect(pkg.publishConfig.access).toBe('public');
    });

    it('is not marked private, which would block publishing entirely', () => {
        expect(pkg.private).toBeUndefined();
    });

    // A package published restricted can be flipped to public afterwards, but the
    // version that went out restricted stays that way. Declaring it up front is
    // the only point at which the mistake is free to make.
    it('names a scope, which is exactly why the declaration above is needed', () => {
        // If this ever stops being true the assertion above is harmless; the point
        // is that the reason for it is recorded next to the reason it exists.
        expect(pkg.name.startsWith('@')).toBe(true);
    });
});

describe('the published tarball', () => {
    it('ships the two bin names, since both are documented as installable', () => {
        // A bin that is not in the tarball produces a broken install: npm links
        // it from the package directory, and if the file is absent the command
        // does not exist.
        const files = require('child_process')
            .execFileSync('npm', ['pack', '--dry-run', '--json'], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        const shipped = JSON.parse(files)[0].files.map((f) => f.path);

        for (const binPath of new Set(Object.values(pkg.bin))) {
            expect({ binPath, shipped: shipped.includes(binPath) })
                .toEqual({ binPath, shipped: true });
        }
    });

    it('ships the module the exports map points at', () => {
        const shipped = require('child_process')
            .execFileSync('npm', ['pack', '--dry-run', '--json'], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        const names = JSON.parse(shipped)[0].files.map((f) => f.path);

        for (const entry of Object.values(pkg.exports)) {
            if (typeof entry !== 'string') continue;
            expect({ entry, shipped: names.includes(entry.replace(/^\.\//, '')) })
                .toEqual({ entry, shipped: true });
        }
    });

    it('ships no auth state, since the session is a live credential', () => {
        const shipped = require('child_process')
            .execFileSync('npm', ['pack', '--dry-run', '--json'], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        const names = JSON.parse(shipped)[0].files.map((f) => f.path);
        expect(names.filter((n) => /auth.*\.json$/i.test(n))).toEqual([]);
    });
});

describe('release prerequisites', () => {
    it('pins the three step packages to exact versions', () => {
        // Not a publish setting, but the same class of mistake: a range here
        // resolves independently per install and reintroduces the Playwright
        // drift this package exists to prevent.
        for (const name of [
            '@msout/microsoft-webauth',
            '@msout/microsoft-onenote-list-notebooks',
            '@msout/microsoft-onenote-export-notebook',
        ]) {
            expect({ name, spec: pkg.dependencies[name] })
                .toEqual({ name, spec: pkg.dependencies[name] });
            expect(pkg.dependencies[name]).not.toMatch(/[\^~]/);
        }
    });

    // 0.1.0 and 0.1.1 shipped without these two files. The `files` whitelist
    // listed src/ and the documents, so the tarball had 11 files and neither
    // script - and six of the fixes in 0.1.1 live inside those two files. A
    // consumer who installed the package and then tried to run a container from
    // it had no entrypoint to build an image from.
    //
    // Found by installing the published tarball and looking for the files the
    // README tells people to use. The publish gate missed it because it checked
    // what must NOT ship, never what must.
    it('ships entrypoint.sh and start-container.sh', () => {
        const shipped = require('child_process')
            .execFileSync('npm', ['pack', '--dry-run', '--json'], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        const names = JSON.parse(shipped)[0].files.map((f) => f.path);

        for (const script of ['entrypoint.sh', 'start-container.sh']) {
            expect({ script, shipped: names.includes(script) })
                .toEqual({ script, shipped: true });
        }
    });

    // Executable matters as much as present: a tarball that ships them as 0644
    // gives `Cannot exec: permission denied` from the ENTRYPOINT line.
    it('ships both scripts executable', () => {
        for (const script of ['entrypoint.sh', 'start-container.sh']) {
            const mode = fs.statSync(path.join(ROOT, script)).mode;
            expect({ script, executable: (mode & 0o111) !== 0 })
                .toEqual({ script, executable: true });
        }
    });

    it('has no npm token in .npmrc, because publishing goes through OIDC', () => {
        const npmrc = path.join(ROOT, '.npmrc');
        if (!fs.existsSync(npmrc)) return; // nothing to assert
        expect(fs.readFileSync(npmrc, 'utf8')).not.toMatch(/_authToken/);
    });
});
