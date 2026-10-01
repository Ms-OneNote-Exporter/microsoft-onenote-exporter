/**
 * @fileoverview Adapter over @msout/microsoft-onenote-list-notebooks.
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
    return require('@msout/microsoft-onenote-list-notebooks');
}

/**
 * Lists the notebooks on the signed-in account.
 *
 * An empty result is not an error: it means the account is authenticated and has
 * no notebooks, which is a different situation from a failure and is reported as
 * success. The distinction matters because the export step can still work from a
 * `--notebook-link` when the listing comes back empty - Microsoft for the web
 * does not always list a notebook the account can otherwise open directly.
 *
 * @param {object} options - CLI options
 * @returns {Promise<object>} { notebooks, exitCode }
 */
async function list(options) {
    const { listNotebooks } = load();

    const notebooks = await listNotebooks({
        authFile: options.authFile,
        notheadless: options.notheadless,
        dodump: options.dodump,
    });

    if (notebooks.length === 0) {
        logger.warn('No notebooks were found on this account.');
        logger.warn('If you know the notebook exists, export it by URL:');
        logger.warn('  microsoft-onenote-exporter export --notebook-link <url>');
    } else {
        logger.step('\nAvailable notebooks:');
        notebooks.forEach((nb, index) => {
            logger.info(`${index + 1}. ${nb.name}`);
            logger.debug(`   ${nb.url}`);
        });
    }

    return { notebooks, exitCode: EXIT.ok };
}

module.exports = { list };
