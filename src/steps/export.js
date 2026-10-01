/**
 * @fileoverview Adapter over @msout/microsoft-onenote-export-notebook.
 * @copyright 2026 msout
 */
const logger = require('../logger');
const { EXIT } = require('../config');

/**
 * Loads the package.
 *
 * Lazily, for the same reason as in steps/auth.js: its logger is a singleton
 * constructed at require time and reads the log directory from the environment,
 * so it must not be loaded before src/index.js has set ONENOTE_EXPORT_LOG_DIR.
 */
function load() {
    return require('@msout/microsoft-onenote-export-notebook');
}

/**
 * Exports one notebook to Obsidian-flavoured Markdown.
 *
 * On exit codes. That package uses three - 1 for a run that produced nothing
 * usable, 2 for bad arguments, 3 for a run that finished while missing pages,
 * sections or groups - and it reports 3 by setting `process.exitCode` as a side
 * effect from inside the export, then returns its stats object.
 *
 * The return value is the better channel and this uses it: exitCodeForStats is
 * exported precisely so a caller can ask the same question the package asked,
 * and reading a global that a library mutated is how a composed pipeline ends up
 * with the wrong status. src/index.js sets the real exit code afterwards, which
 * also means the side effect is overwritten rather than inherited.
 *
 * Three is deliberately not collapsed into one here. Partial output is worth
 * keeping and re-running, and a caller that cannot tell "partial" from "nothing"
 * has to discard both.
 *
 * @param {object} options - CLI options
 * @returns {Promise<object>} { stats, exitCode }
 */
async function exportNotebook(options) {
    const { runExport, exitCodeForStats } = load();

    const stats = await runExport({
        authFile: options.authFile,
        notebook: options.notebook,
        notebookLink: options.notebookLink,
        exportDir: options.outputDir,
        notheadless: options.notheadless,
        dodump: options.dodump,
        nopassasked: options.nopassasked,
        nonInteractive: options.nonInteractive,
    });

    // The package's own rule, not a copy of it: if the two ever disagree, this
    // one follows the package.
    const exitCode = exitCodeForStats(stats);

    if (exitCode === EXIT.partial) {
        logger.warn('The export finished, but some pages, sections or groups are missing.');
        logger.warn('The notes that were written are complete, and name any asset they could not download.');
        logger.warn('Re-run the export to try again.');
    }

    return { stats, exitCode };
}

module.exports = { exportNotebook };
