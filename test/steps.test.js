/**
 * Tests for the step adapters, with the three packages replaced by stubs.
 *
 * The point is to pin the translation: which CLI option becomes which library
 * option, and what each adapter returns. The packages themselves are tested in
 * their own repositories, and stubbing them here is what lets this suite run in
 * under a second without a browser or an account.
 */
const path = require('path');

const EXIT = require('../src/config').EXIT;

/** Builds a jest module mock for a step package. */
function mockPackage(exports) {
    return jest.fn(() => exports);
}

/**
 * Replaces a step package for the duration of one test.
 *
 * The adapters require their package lazily, inside the command, so a mock has to
 * be registered before the adapter runs - and unregistered after, or it leaks
 * into the next test through the require cache.
 */
async function withPackage(name, exports, fn) {
    jest.resetModules();
    jest.doMock(name, mockPackage(exports), { virtual: true });
    try {
        await fn();
    } finally {
        jest.dontMock(name);
        jest.resetModules();
    }
}

const AUTH_FILE = '/tmp/session.json';

describe('steps/auth - login', () => {
    it('maps the CLI options onto the names the package expects', async () => {
        const login = jest.fn().mockResolvedValue(undefined);
        await withPackage('@msout/microsoft-webauth', { login }, async () => {
            await require('../src/steps/auth').login({
                email: 'someone@example.com',
                password: 'hunter2',
                authFile: AUTH_FILE,
                notheadless: false,
                dodump: true,
                screenshot: false,
                against: 'outlook',
            });
        });

        expect(login).toHaveBeenCalledTimes(1);
        expect(login).toHaveBeenCalledWith({
            email: 'someone@example.com',
            password: 'hunter2',
            // outlook, not onenote: the URL is resolved here so the adapter's
            // mapping is visible in one place.
            targetUrl: 'https://outlook.cloud.microsoft/mail/',
            authFile: AUTH_FILE,
            notheadless: false,
            dodump: true,
            screenshot: false,
        });
    });

    it('defaults to the OneNote target', async () => {
        const login = jest.fn().mockResolvedValue(undefined);
        await withPackage('@msout/microsoft-webauth', { login }, async () => {
            await require('../src/steps/auth').login({ authFile: AUTH_FILE, against: 'onenote' });
        });
        expect(login.mock.calls[0][0].targetUrl).toBe('https://onenote.cloud.microsoft/notebooks');
    });

    // A flag that silently does nothing is worse than a missing flag: the user
    // debugs for an hour wondering why there are no PNGs.
    it('turns --screenshot into --dodump rather than ignoring it', async () => {
        const login = jest.fn().mockResolvedValue(undefined);
        await withPackage('@msout/microsoft-webauth', { login }, async () => {
            await require('../src/steps/auth').login({
                authFile: AUTH_FILE,
                screenshot: true,
                dodump: false,
            });
        });
        expect(login.mock.calls[0][0].dodump).toBe(true);
    });

    it('reports success as exit code 0', async () => {
        const login = jest.fn().mockResolvedValue(undefined);
        let result;
        await withPackage('@msout/microsoft-webauth', { login }, async () => {
            result = await require('../src/steps/auth').login({ authFile: AUTH_FILE });
        });
        expect(result).toEqual({ exitCode: EXIT.ok });
    });
});

describe('steps/auth - check', () => {
    it('returns a failure code and does not claim success when the session is dead', async () => {
        const checkAuth = jest.fn().mockResolvedValue(false);
        const getAuthMeta = jest.fn().mockResolvedValue(null);
        let result;
        await withPackage('@msout/microsoft-webauth', { checkAuth, getAuthMeta }, async () => {
            result = await require('../src/steps/auth').check({ authFile: AUTH_FILE, against: 'onenote' });
        });

        expect(result.authenticated).toBe(false);
        // The point of the whole command: a dead session must not look like a
        // working one, or a pipeline runs an export that cannot succeed.
        expect(result.exitCode).toBe(EXIT.failed);
    });

    it('passes the auth file to both checkAuth and getAuthMeta', async () => {
        const checkAuth = jest.fn().mockResolvedValue(true);
        const getAuthMeta = jest.fn().mockResolvedValue({ email: 'someone@example.com', loginTime: '2026-10-01T09:00:00Z' });
        await withPackage('@msout/microsoft-webauth', { checkAuth, getAuthMeta }, async () => {
            await require('../src/steps/auth').check({ authFile: AUTH_FILE, against: 'onenote' });
        });

        // checkAuth takes (targetUrl, authFile) - the order matters and is easy
        // to transpose, so it is asserted rather than trusted.
        expect(checkAuth).toHaveBeenCalledWith('https://onenote.cloud.microsoft/notebooks', AUTH_FILE);
        expect(getAuthMeta).toHaveBeenCalledWith(AUTH_FILE);
    });

    it('returns success when the session is valid', async () => {
        const checkAuth = jest.fn().mockResolvedValue(true);
        const getAuthMeta = jest.fn().mockResolvedValue(null);
        let result;
        await withPackage('@msout/microsoft-webauth', { checkAuth, getAuthMeta }, async () => {
            result = await require('../src/steps/auth').check({ authFile: AUTH_FILE, against: 'onenote' });
        });
        expect(result).toEqual({ authenticated: true, exitCode: EXIT.ok });
    });
});

describe('steps/auth - logout', () => {
    it('passes the auth file through', async () => {
        const logout = jest.fn().mockResolvedValue(undefined);
        await withPackage('@msout/microsoft-webauth', { logout }, async () => {
            await require('../src/steps/auth').logout({ authFile: AUTH_FILE });
        });
        expect(logout).toHaveBeenCalledWith(AUTH_FILE);
    });
});

describe('steps/auth - defaultAuthFile', () => {
    // The whole reason webauth exposes ./config: two packages each carrying
    // their own idea of where the session lives is how "logged in but the export
    // cannot find the file" happens.
    it('comes from the package that owns the convention, not from a second copy', async () => {
        jest.resetModules();
        jest.doMock(
            '@msout/microsoft-webauth/config',
            () => ({ DEFAULT_AUTH_FILE: '/the/one/true/path.json' }),
            { virtual: true }
        );
        const { defaultAuthFile } = require('../src/steps/auth');
        expect(defaultAuthFile()).toBe('/the/one/true/path.json');
        jest.dontMock('@msout/microsoft-webauth/config');
        jest.resetModules();
    });
});

describe('steps/list', () => {
    it('maps the options and returns the notebooks', async () => {
        const listNotebooks = jest.fn().mockResolvedValue([
            { name: 'Work', url: 'https://example.com/work', id: '1' },
            { name: 'Personal', url: 'https://example.com/personal', id: '2' },
        ]);
        let result;
        await withPackage('@msout/microsoft-onenote-list-notebooks', { listNotebooks }, async () => {
            result = await require('../src/steps/list').list({ authFile: AUTH_FILE, notheadless: false, dodump: false });
        });

        expect(listNotebooks).toHaveBeenCalledWith({
            authFile: AUTH_FILE,
            notheadless: false,
            dodump: false,
        });
        expect(result.notebooks).toHaveLength(2);
        expect(result.exitCode).toBe(EXIT.ok);
    });

    // An empty listing is a successful answer, not a failure - and it is still
    // worth reporting, because --notebook-link can export a notebook that
    // /notebooks did not list.
    it('treats an empty listing as success, not as an error', async () => {
        const listNotebooks = jest.fn().mockResolvedValue([]);
        let result;
        await withPackage('@msout/microsoft-onenote-list-notebooks', { listNotebooks }, async () => {
            result = await require('../src/steps/list').list({ authFile: AUTH_FILE });
        });
        expect(result.notebooks).toEqual([]);
        expect(result.exitCode).toBe(EXIT.ok);
    });
});

describe('steps/export', () => {
    const okStats = { failedPages: 0, failedSections: 0, failedGroups: 0, pages: 12, assets: 30 };
    const partialStats = { failedPages: 2, failedSections: 1, failedGroups: 0, pages: 12, assets: 28 };

    // The package's own rule is used rather than a copy of it, so the umbrella
    // and the export CLI can never disagree about whether a run succeeded.
    it('asks the package for its exit code, not a local reimplementation', async () => {
        const runExport = jest.fn().mockResolvedValue(okStats);
        const exitCodeForStats = jest.fn().mockReturnValue(0);
        let result;
        await withPackage(
            '@msout/microsoft-onenote-export-notebook',
            { runExport, exitCodeForStats },
            async () => {
                result = await require('../src/steps/export').exportNotebook({ authFile: AUTH_FILE });
            }
        );

        expect(exitCodeForStats).toHaveBeenCalledWith(okStats);
        expect(result.exitCode).toBe(EXIT.ok);
    });

    it('passes the partial exit code through rather than collapsing it to ok', async () => {
        const runExport = jest.fn().mockResolvedValue(partialStats);
        const exitCodeForStats = jest.fn().mockReturnValue(EXIT.partial);
        let result;
        await withPackage(
            '@msout/microsoft-onenote-export-notebook',
            { runExport, exitCodeForStats },
            async () => {
                result = await require('../src/steps/export').exportNotebook({ authFile: AUTH_FILE });
            }
        );

        // 3 is not an error: the notes that were written are good, and the run
        // says which assets are missing. Collapsing it to 0 loses that, and
        // collapsing it to 1 would throw away output worth keeping.
        expect(result.exitCode).toBe(EXIT.partial);
    });

    it('renames --output-dir to the exportDir the package expects', async () => {
        const runExport = jest.fn().mockResolvedValue(okStats);
        await withPackage(
            '@msout/microsoft-onenote-export-notebook',
            { runExport, exitCodeForStats: () => 0 },
            async () => {
                await require('../src/steps/export').exportNotebook({
                    authFile: AUTH_FILE,
                    outputDir: '/data/output',
                    notebook: 'Work',
                });
            }
        );

        expect(runExport).toHaveBeenCalledWith(
            expect.objectContaining({ exportDir: '/data/output', notebook: 'Work', authFile: AUTH_FILE })
        );
    });

    // The bug this prevents, and it was a real one. That package's own default is
    // `path.resolve(__dirname, '../output')`, which as a dependency resolves to
    // node_modules/@msout/microsoft-onenote-export-notebook/output. Inside the
    // container node_modules is root-owned, so a default export failed with EACCES
    // after it had signed in, found the notebook and loaded the editor - so
    // exportDir is always passed, never left undefined.
    it('always passes an absolute exportDir, never the package its own default', async () => {
        const runExport = jest.fn().mockResolvedValue(okStats);
        await withPackage(
            '@msout/microsoft-onenote-export-notebook',
            { runExport, exitCodeForStats: () => 0 },
            async () => {
                await require('../src/steps/export').exportNotebook({ authFile: AUTH_FILE });
            }
        );

        const { exportDir } = runExport.mock.calls[0][0];
        expect(path.isAbsolute(exportDir)).toBe(true);
        expect(exportDir).not.toContain('node_modules');
        expect(exportDir).toBe(path.resolve(process.cwd(), 'output'));
    });

    it('resolves a relative --output-dir against the working directory', async () => {
        const runExport = jest.fn().mockResolvedValue(okStats);
        await withPackage(
            '@msout/microsoft-onenote-export-notebook',
            { runExport, exitCodeForStats: () => 0 },
            async () => {
                await require('../src/steps/export').exportNotebook({
                    authFile: AUTH_FILE,
                    outputDir: 'notes',
                });
            }
        );
        expect(runExport.mock.calls[0][0].exportDir).toBe(path.resolve(process.cwd(), 'notes'));
    });

    // Guards the option this adapter exists to add: a CLI flag the package does
    // not understand is silently dropped, and the flag appears to do nothing.
    it('does not pass through options the package has never heard of', async () => {
        const runExport = jest.fn().mockResolvedValue(okStats);
        await withPackage(
            '@msout/microsoft-onenote-export-notebook',
            { runExport, exitCodeForStats: () => 0 },
            async () => {
                await require('../src/steps/export').exportNotebook({
                    authFile: AUTH_FILE,
                    // CLI-only flags, plus the umbrellas' own verbosity ones.
                    outputDir: undefined,
                    verbose: true,
                    quiet: false,
                    against: 'onenote',
                });
            }
        );

        const passed = runExport.mock.calls[0][0];
        expect(Object.keys(passed).sort()).toEqual(
            ['authFile', 'dodump', 'exportDir', 'nonInteractive', 'notebook', 'notebookLink', 'nopassasked', 'notheadless'].sort()
        );
        expect(passed).not.toHaveProperty('verbose');
        expect(passed).not.toHaveProperty('against');
    });
});
