/**
 * Tests for how the logger renders its arguments.
 *
 * Every case here is a bug that actually happened, or a shape that reaches the
 * logger from somewhere in the three step packages.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const LOG_ENV = 'ONENOTE_EXPORT_LOG_DIR';

/** Runs `fn` with a fresh logger writing into a throwaway directory. */
function withLogger(fn, env = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logfmt-'));
    const savedLog = process.env[LOG_ENV];
    const savedLevel = process.env.ONENOTE_EXPORT_LOG_LEVEL;

    process.env[LOG_ENV] = tmp;
    delete process.env.ONENOTE_EXPORT_LOG_LEVEL;
    Object.assign(process.env, env);
    jest.resetModules();

    const logger = require('../src/logger');
    try {
        return fn(logger, tmp);
    } finally {
        if (savedLog === undefined) delete process.env[LOG_ENV];
        else process.env[LOG_ENV] = savedLog;
        if (savedLevel === undefined) delete process.env.ONENOTE_EXPORT_LOG_LEVEL;
        else process.env.ONENOTE_EXPORT_LOG_LEVEL = savedLevel;
        jest.resetModules();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** Captures whatever a logger call writes to stderr. */
function captureStderr(fn) {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
    };
    try {
        fn();
    } finally {
        process.stderr.write = original;
    }
    return chunks.join('');
}

describe('rendering an Error passed as a second argument', () => {
    // The bug. The export step reports failures as
    // `logger.error('Export failed:', e)`, so an Error lands in the second
    // argument. The logger formatted only the first one, so it printed the
    // string and dropped the error entirely - a real export failure printed
    // "failed:" and nothing else, with an empty log file beside it.
    it('keeps the message when the Error is the second argument', () => {
        const boom = new Error('Notebook editor never appeared');
        withLogger((logger) => {
            captureStderr(() => logger.error('Export failed:', boom));
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('Export failed:');
            expect(written).toContain('Notebook editor never appeared');
        });
    });

    it('includes the stack, not just the message', () => {
        const boom = new Error('boom');
        boom.stack = 'Error: boom\n    at exportContent (/app/src/exporter.js:1213)';
        withLogger((logger) => {
            logger.error('Export failed:', boom);
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('exporter.js:1213');
        });
    });

    it('still handles an Error passed as the only argument', () => {
        withLogger((logger) => {
            logger.error(new Error('standalone'));
            expect(fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8')).toContain('standalone');
        });
    });

    it('handles the two-string form used for multi-line context', () => {
        withLogger((logger) => {
            logger.error('first line', 'second line');
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('first line second line');
        });
    });
});

describe('rendering other argument shapes', () => {
    it('pretty-prints an object', () => {
        withLogger((logger) => {
            logger.info({ pages: 3, assets: 12 });
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('"pages": 3');
        });
    });

    // A logger that throws while reporting a failure replaces the failure with
    // its own, and the original is lost. This is the opposite of its purpose.
    it('does not throw on a circular object', () => {
        const circular = { name: 'loop' };
        circular.self = circular;
        withLogger((logger) => {
            expect(() => logger.info(circular)).not.toThrow();
            expect(fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8')).toContain('loop');
        });
    });

    it('handles undefined and null without writing "undefined" noise', () => {
        withLogger((logger) => {
            logger.info('value is', undefined);
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('value is');
        });
    });

    it('writes nothing when every argument is empty', () => {
        withLogger((logger) => {
            logger.info('');
            expect(fs.existsSync(path.join(logger.logDir, 'app.log'))).toBe(false);
        });
    });

    // A number or a boolean is not an Error and not a string, so it goes through
    // JSON.stringify - which must still produce readable output rather than
    // throwing on BigInt.
    it('renders a BigInt instead of throwing', () => {
        withLogger((logger) => {
            expect(() => logger.info(BigInt(42))).not.toThrow();
        });
    });
});

describe('where each level is written', () => {
    it('sends errors to stderr and everything else to stdout', () => {
        withLogger((logger) => {
            const errOut = captureStderr(() => logger.error('to stderr'));
            expect(errOut).toContain('to stderr');

            const chunks = [];
            const original = process.stdout.write;
            process.stdout.write = (c) => { chunks.push(String(c)); return true; };
            try {
                logger.info('to stdout');
            } finally {
                process.stdout.write = original;
            }
            expect(chunks.join('')).toContain('to stdout');
        });
    });

    // Both streams append to the same file, so a failure is diagnosable from the
    // log alone after the fact - which is the whole point of sharing one app.log.
    it('records both streams in the same app.log', () => {
        withLogger((logger) => {
            captureStderr(() => logger.error('an error line'));
            logger.info('an info line');
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('an error line');
            expect(written).toContain('an info line');
        });
    });

    it('prefixes every line of a multi-line message with the level', () => {
        withLogger((logger) => {
            logger.error('line one\nline two');
            const written = fs.readFileSync(path.join(logger.logDir, 'app.log'), 'utf8');
            expect(written).toContain('[error] line one');
            expect(written).toContain('[error] line two');
        });
    });
});
