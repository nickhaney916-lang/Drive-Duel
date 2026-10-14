const fs = require('node:fs');
const assert = require('node:assert/strict');
const file = 'test-results/load-100-report.json';
assert.ok(fs.existsSync(file), 'Expected 100-player test report');
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const [key, expected] of Object.entries({sessions:100, groups:78, cpuOpponents:77, puntPoints:1320, finalPoints:3720, reconnectedSessions:10, unexpectedRequests:0})) {
 assert.equal(report[key], expected, key);
}
assert.match(report.transport, /mocked/i);
console.log('Verified isolated load-test report');
