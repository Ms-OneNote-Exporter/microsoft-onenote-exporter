/**
 * @fileoverview Adapters over @msout/microsoft-webauth.
 * @copyright 2026 msout
 *
 * This is a translation layer and nothing more: it renames the CLI's options into
 * the names that package expects, calls one function, and returns. All the
 * behaviour - the login flow, the blocking-screen handling, the credential
 * redaction in dumps - stays in that package, which is separately installable and
 * separately tested. If a rule ever needs to exist in two places, it belongs
 * here as a comment and not as code.
 */
const logger = require('../logger');
const { TARGETS, EXIT } = require('../config');

/**
 * Loads the package.
 *
 * Required lazily, inside the command, rather than at the top of the module: the
 * package's logger is a singleton built at require time and decides its log
 * directory from the environment, so it must not be loaded before src/index.js
 * has set ONENOTE_EXPORT_LOG_DIR. Loading it at import time would put its app.log
 * somewhere this run never looks.
 */
function load() {
    return require('@msout/microsoft-webauth');
}

/** The auth file default, read from the package that owns the convention. */
function defaultAuthFile() {
    return require('@msout/microsoft-webauth/config').DEFAULT_AUTH_FILE;
}

/** Resolves the --against value to a URL the login flow will accept. */
function targetUrl(against) {
    return against === 'outlook' ? TARGETS.outlook : TARGETS.onenote;
}

/**
 * Signs in and writes the session to the auth file.
 *
 * Note what decides headless: that package runs headless only when it is given
 * both an email and a password. Without them it shows the browser, because an
 * interactive login needs somewhere to type the password and click the MFA
 * prompt. `--notheadless` is therefore only meaningful alongside credentials, and
 * saying so is better than letting a flag appear to do nothing.
 *
 * @param {object} options - CLI options
 * @returns {Promise<object>} The auth metadata the package recorded
 */
async function login(options) {
    const { login: doLogin } = load();

    if (!options.notheadless && !(options.email && options.password)) {
        logger.debug('No --email/--password given, so the browser will be shown for an interactive login.');
    }
    if (options.screenshot && !options.dodump) {
        logger.warn('--screenshot only applies to the pages written by --dodump; enabling --dodump as well.');
        options.dodump = true;
    }

    await doLogin({
        email: options.email,
        password: options.password,
        targetUrl: targetUrl(options.against),
        authFile: options.authFile,
        notheadless: options.notheadless,
        dodump: options.dodump,
        screenshot: options.screenshot,
    });

    return { exitCode: EXIT.ok };
}

/**
 * Reports whether the saved session still works.
 *
 * Worth being precise about what this proves: the underlying check launches a
 * browser, loads the auth file and follows the redirect. If it redirects to a
 * Microsoft login page the session is dead, and the package deletes the stale
 * file. So a `false` here does not just mean "not authenticated", it means the
 * file has been cleaned up and the next command needs a fresh `login`.
 *
 * @param {object} options - CLI options
 * @returns {Promise<object>} { authenticated, exitCode }
 */
async function check(options) {
    const { checkAuth, getAuthMeta } = load();

    const authenticated = await checkAuth(targetUrl(options.against), options.authFile);

    if (!authenticated) {
        logger.error('Not authenticated, or the saved session has expired.');
        logger.error('Run "microsoft-onenote-exporter login" to create a new one.');
        return { authenticated: false, exitCode: EXIT.failed };
    }

    logger.success(`Authenticated${options.against === 'outlook' ? ' against Outlook' : ''}.`);

    const meta = await getAuthMeta(options.authFile);
    if (meta && meta.email) {
        logger.info(`Signed in as: ${meta.email}`);
    }
    if (meta && meta.loginTime) {
        logger.info(`Session started: ${new Date(meta.loginTime).toLocaleString()}`);
    }

    return { authenticated: true, exitCode: EXIT.ok };
}

/**
 * Deletes the saved session and its metadata.
 *
 * @param {object} options - CLI options
 * @returns {Promise<object>} { exitCode }
 */
async function logout(options) {
    const { logout: doLogout } = load();

    await doLogout(options.authFile);
    logger.success('Signed out. The saved session has been deleted.');
    return { exitCode: EXIT.ok };
}

module.exports = { login, check, logout, defaultAuthFile, targetUrl };
