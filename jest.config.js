module.exports = {
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.local-tarballs/'],
    collectCoverageFrom: ['src/**/*.js'],
    coverageDirectory: 'coverage',
    verbose: true,
};
