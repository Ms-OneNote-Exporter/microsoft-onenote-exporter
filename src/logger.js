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

    _write(level, message, color) {
        if (!this._enabled(level)) return;

        const stamp = this._timestamp();
        const body = message instanceof Error
            ? (message.stack || message.message)
            : (typeof message === 'string' ? message : JSON.stringify(message, null, 2));

        const plain = body.split('\n').map((line) => `[${level}] ${line}`).join('\n');
        const colored = body.split('\n').map((line) => `${chalk.gray(stamp)} ${color(`[${level}]`)} ${line}`).join('\n');

        // mode only applies at creation; an app.log from another logger in this
        // same directory may predate it and be 0644.
        fs.appendFileSync(this.logFilePath, `${plain}\n`, { mode: 0o600 });

        const stream = level === 'error' ? process.stderr : process.stdout;
        stream.write(`${colored}\n`);
    }

    debug(message) { this._write('debug', message, chalk.gray); }
    info(message) { this._write('info', message, chalk.blue); }
    step(message) { this._write('step', message, chalk.magenta); }
    success(message) { this._write('success', message, chalk.green); }
    warn(message) { this._write('warn', message, chalk.yellow); }
    error(message) { this._write('error', message, chalk.red); }
}

module.exports = new Logger();
