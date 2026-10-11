module.exports = { testDir: './tests', timeout: 180000, expect: { timeout: 20000 }, retries: 0, workers: 1, reporter: [['list'], ['html', { open: 'never' }]], use: { trace: 'retain-on-failure' } };
