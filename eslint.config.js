const js = require('@eslint/js');

module.exports = [
    {
        // The shell scripts are build inputs, not JavaScript. Without this they
        // are picked up by the `**/*.js`-adjacent default patterns and reported
        // as parse errors, which is noise rather than a finding.
        ignores: ['**/*.sh', 'node_modules/**', 'coverage/**', '.local-tarballs/**'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                __dirname: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                jest: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-console': 'error',
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        // Test files legitimately reach for a few globals and, in wiring.test.js,
        // spawn a child process.
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                __dirname: 'readonly',
                jest: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
            },
        },
        rules: {
            'no-console': 'off',
        },
    },
];
