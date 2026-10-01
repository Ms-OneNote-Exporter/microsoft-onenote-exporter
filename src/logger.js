/**
 * @fileoverview Logger for the umbrella CLI.
 * @copyright 2026 msout
 *
 * A fourth logger, which is not the point of this exercise but is unavoidable
 * while the three steps are separate packages: none of them exports its logger,
 * and each constructs its own singleton at require time. This one handles the
 * umbrella's own messages, and points the other three at the same directory (see
 * src/config.js shareLogDir) so a run produces one app.log.
 */
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { resolveLogDir } = require('./config');

/** Severity order, lowest first. A message is emitted if its level >= the threshold. */
const LEVELS = { debug: 10, info: 20, step: 20, success: 20, warn: 30, error: 40 };

/**
 * JSON.stringify that cannot throw, and that still says something useful.
 *
 * A logger that throws while reporting a failure replaces the failure with its
 * own, and the original is lost - the opposite of what a logger is for.
 * Circular structures are the usual cause, and this logger is handed whatever a
 * deep call site thought was worth mentioning.
 *
 * The fallback walks the object and renders what it can rather than returning
 * String(value), which for a circular object yields "[object Object]" and throws
 * away every field - including the ones outside the cycle, which were the reason
 * for logging it in the first place.
 */
function safeStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        try {
            return JSON.stringify(value, circularReplacer(), 2);
        } catch {
            return String(value);
        }
    }
}

/** Marks already-visited objects as "[circular]" instead of recursing forever. */
function circularReplacer() {
    const seen = new WeakSet();
    return (key, val) => {
        if (val !== null && typeof val === 'object') {
            if (seen.has(val)) return '[circular]';
            seen.add(val);
        }
        return val;
    };
}

class Logger {
    constructor() {
        this.months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        this.logDir = resolveLogDir();
        this.logFilePath = path.join(this.logDir, 'app.log');
        this.level = Logger._initialLevel();
        fs.ensureDirSync(this.logDir);
    }

    /**
     * Reads the initial threshold from the environment.
     *
     * ONENOTE_EXPORT_LOG_LEVEL is the name the export step already uses, so
     * `--verbose` and a container's environment variable set the same thing for
     * all four loggers rather than two of them.
     */
    static _initialLevel() {
        const raw = (process.env.ONENOTE_EXPORT_LOG_LEVEL || '').toLowerCase().trim();
        if (raw === 'debug' || raw === 'verbose') return LEVELS.debug;
        if (raw === 'warn' || raw === 'quiet') return LEVELS.warn;
        if (raw === 'error') return LEVELS.error;
        return LEVELS.info;
    }

    /**
     * Raises or lowers the threshold at runtime.
     * @param {string} name - One of debug|info|warn|error
     */
    setLevel(name) {
        const level = LEVELS[(name || '').toLowerCase()];
        if (level !== undefined) {
            this.level = level;
        }
    }

    /** True when a message at `level` should be emitted. */
    _enabled(level) {
        return (LEVELS[level] ?? LEVELS.info) >= this.level;
    }

    _timestamp() {
        const now = new Date();
        return `[${this.months[now.getMonth()]} ${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().split(' ')[0]}]`;
    }

    _stripColors(str) {
        // eslint-disable-next-line no-control-regex
        return str.replace(/\u001b\[[0-9;]*m/g, '');
    }

    /**
     * Formats one call's worth of arguments into a printable string.
     *
     * Errors are read out of the argument list rather than being passed whole.
     * This exists because of a real failure: the export step's catch reports
     * `logger.error('Export failed:', e)`, so an Error arrives as the *second*
     * argument, not the first. Formatting only the first argument stringified it
     * and dropped the stack, so a failure that had navigated OneNote, found the
     * notebook and loaded the editor reported nothing but the words
     * "failed:" - no message, no stack, nothing in the log file either.
     *
     * The extra arguments are joined after the first rather than dropped, which
     * is what makes `error('context:', err)` read the way it was written.
     */
    _format(args) {
        return args
            .map((part) => {
                if (part instanceof Error) return part.stack || part.message;
                if (typeof part === 'string') return part;
                return safeStringify(part);
            })
            .join(' ')
            .trim();
    }

    _write(level, args, color) {
        if (!this._enabled(level)) return;

        const stamp = this._timestamp();
        const body = this._format(args);
        if (!body) return;

        const plain = body.split('\n').map((line) => `[${level}] ${line}`).join('\n');
        const colored = body.split('\n').map((line) => `${chalk.gray(stamp)} ${color(`[${level}]`)} ${line}`).join('\n');

        // mode only applies at creation; an app.log from another logger in this
        // same directory may predate it and be 0644.
        fs.appendFileSync(this.logFilePath, `${plain}\n`, { mode: 0o600 });

        const stream = level === 'error' ? process.stderr : process.stdout;
        stream.write(`${colored}\n`);
    }

    debug(...args) { this._write('debug', args, chalk.gray); }
    info(...args) { this._write('info', args, chalk.blue); }
    step(...args) { this._write('step', args, chalk.magenta); }
    success(...args) { this._write('success', args, chalk.green); }
    warn(...args) { this._write('warn', args, chalk.yellow); }
    error(...args) { this._write('error', args, chalk.red); }
}

module.exports = new Logger();
