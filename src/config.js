/**
 * @fileoverview Configuration for the umbrella CLI.
 * @copyright 2026 msout
 */
const os = require('os');
const path = require('path');

/** Cached so one run cannot write to two different places. */
let outputDir;

/**
 * Where exported notes go when --output-dir is not given.
 *
 * Absolute, and resolved against the working directory rather than against this
 * package's own location. It has to be: the export step's own default is
 * `<its package dir>/output`, which as a dependency lands inside node_modules -
 * and in the container node_modules is root-owned, so a default export died with
 * EACCES after it had already signed in, found the notebook and loaded the
 * editor. Same class of bug as the log directory, and the same fix: resolve the
 * path here rather than letting a dependency resolve it against its own install
 * location.
 *
 * @param {string} [dir] - Explicit override, resolved to an absolute path
 * @returns {string} Absolute path of the output directory
 */
function defaultOutputDir(dir) {
    if (dir) return path.resolve(dir);
    if (!outputDir) outputDir = path.resolve(process.cwd(), 'output');
    return outputDir;
}

/** Test seam: forgets the cached default so the next call re-resolves it. */
function resetOutputDir() {
    outputDir = undefined;
}

/**
 * Where the three step packages should write their logs.
 *
 * Each of them is a separately installable package with its own logger, and each
 * one is a singleton constructed the moment it is required. This function has to
 * run before any of them is loaded, which is why src/index.js calls it at the
 * very top rather than passing a path around: by the time a step is invoked the
 * log directories have already been decided.
 *
 * The default is <cwd>/logs rather than a per-package directory because all three
 * steps write `app.log` into the same directory, so a pipeline run produces one
 * log with the steps in order rather than three logs in three places.
 */
function resolveLogDir() {
    const override = process.env.ONENOTE_EXPORT_LOG_DIR;
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }
    return path.resolve(process.cwd(), 'logs');
}

/**
 * Points the three step packages at this process's log directory.
 *
 * Setting the environment variable rather than passing an option is not a
 * shortcut, it is the only channel those packages have: each resolves its log
 * directory at require time from ONENOTE_EXPORT_LOG_DIR, and none of them accept
 * a path as an argument. Idempotent, and it never overrides a value the caller
 * already set - a container or a CI step that mounts its own log volume keeps it.
 *
 * @param {string} [logDir] - Directory to use; resolved from the environment when omitted
 * @returns {string} The absolute directory all four loggers will write to
 */
function shareLogDir(logDir = resolveLogDir()) {
    process.env.ONENOTE_EXPORT_LOG_DIR = logDir;
    return logDir;
}

/** The saved session, shared by every step. */
function defaultAuthFile() {
    const home = os.homedir();
    return path.join(home, '.microsoft-webauth', 'auth-file.json');
}

/**
 * Where to authenticate against.
 *
 * Both URLs are the ones the step packages pin. ONENOTE_URL is the pre-rebrand
 * /notebooks path on purpose: Microsoft 365 Copilot moved the app to
 * /copilotnotebooks but /notebooks still redirects there, so a login entered at
 * the old path is detected as authenticated a few seconds later. Re-pinning it
 * here would trade a working alias for a path that can move again - see
 * ONENOTE_URL in @msout/microsoft-webauth.
 */
const TARGETS = {
    onenote: 'https://onenote.cloud.microsoft/notebooks',
    outlook: 'https://outlook.cloud.microsoft/mail/',
};

/** Exit codes, so a caller can tell the outcomes apart without parsing output. */
const EXIT = {
    ok: 0,
    /** The command itself failed: bad arguments, unusable auth file, a dead run. */
    failed: 1,
    /** Unattended use asked for without a way to choose a notebook. */
    usage: 2,
    /** Finished, but pages, sections or groups are missing. Passed through from
     *  @msout/microsoft-onenote-export-notebook, which distinguishes this from a
     *  total failure because partial output is still worth keeping. */
    partial: 3,
};

module.exports = {
    resolveLogDir,
    shareLogDir,
    defaultAuthFile,
    defaultOutputDir,
    resetOutputDir,
    TARGETS,
    EXIT,
};
