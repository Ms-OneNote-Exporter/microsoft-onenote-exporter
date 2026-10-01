const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLogDir, shareLogDir } = require('../src/config');

describe('resolveLogDir', () => {
    let saved;

    beforeEach(() => {
        saved = process.env.ONENOTE_EXPORT_LOG_DIR;
        delete process.env.ONENOTE_EXPORT_LOG_DIR;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.ONENOTE_EXPORT_LOG_DIR;
        else process.env.ONENOTE_EXPORT_LOG_DIR = saved;
    });

    it('defaults to <cwd>/logs, so a run has one log next to its output', () => {
        expect(resolveLogDir()).toBe(path.resolve(process.cwd(), 'logs'));
    });

    it('honours an absolute override', () => {
        process.env.ONENOTE_EXPORT_LOG_DIR = '/tmp/somewhere-else';
        expect(resolveLogDir()).toBe('/tmp/somewhere-else');
    });

    it('resolves a relative override against the cwd', () => {
        process.env.ONENOTE_EXPORT_LOG_DIR = 'relative-logs';
        expect(path.isAbsolute(resolveLogDir())).toBe(true);
        expect(resolveLogDir()).toBe(path.resolve(process.cwd(), 'relative-logs'));
    });

    it('ignores a blank override rather than logging to the filesystem root', () => {
        // path.resolve('') is the cwd, but a whitespace-only value must not
        // silently become the cwd either - that is a typo, and honouring it
        // would write the log somewhere nobody is looking.
        process.env.ONENOTE_EXPORT_LOG_DIR = '   ';
        expect(resolveLogDir()).toBe(path.resolve(process.cwd(), 'logs'));
    });
});

describe('shareLogDir', () => {
    let saved;

    beforeEach(() => {
        saved = process.env.ONENOTE_EXPORT_LOG_DIR;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.ONENOTE_EXPORT_LOG_DIR;
        else process.env.ONENOTE_EXPORT_LOG_DIR = saved;
    });

    // The whole reason this function exists. Each of the three step packages is a
    // singleton logger built at require time that decides its directory from this
    // variable, so if it is not set before they load, one run produces three
    // logs in three places - or, in a container where node_modules is read-only,
    // three failures before the first command runs.
    it('exports the directory the three step loggers will read', () => {
        const chosen = shareLogDir('/tmp/one-log-for-all');
        expect(process.env.ONENOTE_EXPORT_LOG_DIR).toBe(chosen);
        expect(chosen).toBe('/tmp/one-log-for-all');
    });

    it('resolves the default when given nothing', () => {
        delete process.env.ONENOTE_EXPORT_LOG_DIR;
        expect(shareLogDir()).toBe(path.resolve(process.cwd(), 'logs'));
        expect(process.env.ONENOTE_EXPORT_LOG_DIR).toBe(path.resolve(process.cwd(), 'logs'));
    });

    // A container that mounts its own log volume sets this before the process
    // starts. Overwriting it would send those logs somewhere the volume is not.
    it('leaves a value the caller already set alone', () => {
        process.env.ONENOTE_EXPORT_LOG_DIR = '/mounted/logs';
        expect(shareLogDir()).toBe('/mounted/logs');
        expect(process.env.ONENOTE_EXPORT_LOG_DIR).toBe('/mounted/logs');
    });

    it('is idempotent', () => {
        const once = shareLogDir('/tmp/idempotent');
        expect(shareLogDir()).toBe(once);
    });
});

describe('the umbrella logger writes where it says it does', () => {
    let tmp;
    let saved;

    beforeEach(() => {
        saved = process.env.ONENOTE_EXPORT_LOG_DIR;
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrella-log-'));
        jest.resetModules();
        process.env.ONENOTE_EXPORT_LOG_DIR = tmp;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.ONENOTE_EXPORT_LOG_DIR;
        else process.env.ONENOTE_EXPORT_LOG_DIR = saved;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('creates app.log in the override', () => {
        const logger = require('../src/logger');
        logger.info('a message worth keeping');
        expect(fs.readFileSync(path.join(tmp, 'app.log'), 'utf8')).toContain('a message worth keeping');
    });

    it('keeps the log file owner-only', () => {
        const logger = require('../src/logger');
        logger.info('hello');
        if (process.platform === 'win32') return;
        expect(fs.statSync(path.join(tmp, 'app.log')).mode & 0o077).toBe(0);
    });

    // This is where three step loggers and this one meet: all four append to the
    // same app.log, so the file has to interleave them rather than truncate.
    it('appends rather than replacing, so several loggers can share the file', () => {
        const first = require('../src/logger');
        first.info('from the first logger');
        jest.resetModules();
        const second = require('../src/logger');
        second.info('from the second logger');
        const text = fs.readFileSync(path.join(tmp, 'app.log'), 'utf8');
        expect(text).toContain('from the first logger');
        expect(text).toContain('from the second logger');
    });
});

describe('verbosity', () => {
    let tmp;
    let saved;

    beforeEach(() => {
        saved = process.env.ONENOTE_EXPORT_LOG_LEVEL;
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrella-level-'));
        process.env.ONENOTE_EXPORT_LOG_DIR = tmp;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.ONENOTE_EXPORT_LOG_LEVEL;
        else process.env.ONENOTE_EXPORT_LOG_LEVEL = saved;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('defaults to hiding debug output', () => {
        delete process.env.ONENOTE_EXPORT_LOG_LEVEL;
        jest.resetModules();
        const logger = require('../src/logger');
        expect(() => logger.debug('should not appear')).not.toThrow();
        expect(fs.existsSync(path.join(tmp, 'app.log'))).toBe(false);
    });

    // --verbose has to configure all four loggers, not just this one, or the
    // export step stays silent while the umbrella talks.
    it('ONENOTE_EXPORT_LOG_LEVEL=debug turns it on', () => {
        process.env.ONENOTE_EXPORT_LOG_LEVEL = 'debug';
        jest.resetModules();
        const logger = require('../src/logger');
        logger.debug('now visible');
        expect(fs.readFileSync(path.join(tmp, 'app.log'), 'utf8')).toContain('now visible');
    });

    it('setLevel raises the threshold at runtime', () => {
        delete process.env.ONENOTE_EXPORT_LOG_LEVEL;
        jest.resetModules();
        const logger = require('../src/logger');
        logger.setLevel('debug');
        logger.debug('now visible');
        expect(fs.readFileSync(path.join(tmp, 'app.log'), 'utf8')).toContain('now visible');
    });
});
