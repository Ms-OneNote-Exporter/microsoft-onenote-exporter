#!/usr/bin/env node
/**
 * @fileoverview CLI over the three OneNote exporter steps.
 * @copyright 2026 msout
 *
 * One binary, three steps. The packages it drives remain separately installable
 * and separately tested; what this adds is a single command that can do all
 * three, one Playwright install, one Docker image, and one log per run.
 */
const { shareLogDir } = require('./config');

// Before anything else, and before any step package is loaded: each of those
// decides its log directory at require time, from the environment. Doing this
// lower in the file would leave three loggers pointing somewhere this run never
// writes. See shareLogDir for why an environment variable is the only channel
// available.
const LOG_DIR = shareLogDir();

const { program } = require('commander');
const logger = require('./logger');
const { EXIT, TARGETS } = require('./config');
const { version: PKG_VERSION } = require('../package.json');

// Read from ./config rather than from the step package, so `--help` does not
// pull in Playwright and three loggers just to print a default path. steps/auth
// re-exports the same value for anyone who wants the package's own answer.
const { defaultAuthFile } = require('./steps/auth');

/**
 * Options every step understands.
 *
 * Declared once and reused, because a flag that works on `login` but not on
 * `export` is indistinguishable from a bug in the tool.
 */
function sharedOptions(command) {
    return command
        // No "(default: ...)" in the description: commander appends the real
        // value itself, and spelling it out here printed it twice.
        .option('--auth-file <path>', 'Path to the saved session', defaultAuthFile())
        .option('--notheadless', 'Show the browser. Required for an interactive login, which cannot run headless')
        .option('--dodump', 'Write the HTML of each page to the log directory, for debugging')
        .option('-v, --verbose', 'Include debug output')
        .option('-q, --quiet', 'Warnings and errors only');
}

/**
 * Applies the verbosity flags.
 *
 * Sets this process's logger and the environment variable the export step reads,
 * so one flag configures all four loggers instead of two of them.
 */
function applyVerbosity(options) {
    if (options.verbose) {
        logger.setLevel('debug');
        process.env.ONENOTE_EXPORT_LOG_LEVEL = 'debug';
    } else if (options.quiet) {
        logger.setLevel('warn');
        process.env.ONENOTE_EXPORT_LOG_LEVEL = 'warn';
    }
}

/**
 * Runs one step and turns its result into this process's exit code.
 *
 * Every failure path ends here, which is why there is exactly one place that
 * decides the status: a command that reported an error and exited 0 is how a
 * pipeline ends up treating a failed listing as a pass.
 */
async function run(step) {
    try {
        const { exitCode } = await step();
        process.exitCode = exitCode;
    } catch (e) {
        logger.error(`${program.name()} failed:`, e);
        process.exitCode = EXIT.failed;
    }
}

program
    .name('ms-onenote-exporter')
    .description('Sign in to Microsoft OneNote, list the notebooks on the account, and export one to Markdown.')
    .version(PKG_VERSION)
    .addHelpText('after', `
Logs for every step of a run are written to one app.log in:
  ${LOG_DIR}

A typical first run:
  ms-onenote-exporter login
  ms-onenote-exporter list
  ms-onenote-exporter export --notebook "Work"
`);

sharedOptions(
    program
        .command('login')
        .description('Sign in to Microsoft and save the session for the other steps')
)
    .option('--email <email>', 'Account email. Without it, the browser opens and you sign in yourself')
    .option('--password <password>', 'Account password. Supplying it makes the login headless')
    .option('--against <target>', `Service to authenticate against: ${Object.keys(TARGETS).join(' | ')}`, 'onenote')
    .option('--screenshot', 'With --dodump, also save a PNG of each dumped page')
    .action(async (options) => {
        applyVerbosity(options);
        await run(() => require('./steps/auth').login(options));
    });

sharedOptions(
    program
        .command('check')
        .description('Report whether the saved session is still valid')
)
    .option('--against <target>', `Service to check: ${Object.keys(TARGETS).join(' | ')}`, 'onenote')
    .action(async (options) => {
        applyVerbosity(options);
        await run(() => require('./steps/auth').check(options));
    });

sharedOptions(
    program
        .command('logout')
        .description('Delete the saved session and its metadata')
)
    .action(async (options) => {
        applyVerbosity(options);
        await run(() => require('./steps/auth').logout(options));
    });

sharedOptions(
    program
        .command('list')
        .description('List the notebooks on the signed-in account')
)
    .action(async (options) => {
        applyVerbosity(options);
        await run(() => require('./steps/list').list(options));
    });

sharedOptions(
    program
        .command('export')
        .description('Export one notebook to Obsidian-flavoured Markdown')
)
    .option('--notebook <name>', 'Notebook to export, by name (skips the interactive picker)')
    .option('--notebook-link <url>', 'Notebook to export, by URL (skips listing and picking)')
    .option('--output-dir <path>', 'Where to write the Markdown (default: ./output)')
    .option('--nopassasked', 'Skip password-protected sections instead of asking for the password')
    .option('--non-interactive', 'Run unattended: requires --notebook or --notebook-link, and implies --nopassasked')
    .action(async (options) => {
        applyVerbosity(options);

        // Fail before a browser is launched. Left to the export step, an
        // unattended run with no way to choose a notebook reaches the
        // interactive picker and waits forever - which in a container looks
        // exactly like a hung export.
        if (options.nonInteractive && !(options.notebook || options.notebookLink)) {
            logger.error('--non-interactive requires --notebook <name> or --notebook-link <url>.');
            logger.error('Without one of them the export would stop at the interactive notebook picker.');
            process.exitCode = EXIT.usage;
            return;
        }

        await run(() => require('./steps/export').exportNotebook(options));
    });

// A Playwright target that dies mid-run - the tab closed, the renderer crashed,
// the browser was killed - also rejects one of Playwright's own internal
// promises, which nothing awaits. Node treats that as fatal and kills the
// process with a bare stack trace, so a dead OneNote tab would end a run with no
// message, no summary and no status. Report it like any other failure and let
// the run finish unwinding.
process.on('unhandledRejection', (reason) => {
    logger.error('Unexpected internal failure (this is a bug):', reason);
    process.exitCode = EXIT.failed;
});

program.parseAsync().catch((e) => {
    // The handlers above report their own failures; this is the net for anything
    // else, including a throw while arguments were parsed.
    logger.error('Failed:', e);
    process.exitCode = EXIT.failed;
});
