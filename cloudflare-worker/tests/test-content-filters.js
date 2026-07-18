/**
 * Tests for content origin and minimum runtime filtering.
 * Run: node cloudflare-worker/tests/test-content-filters.js
 */

// Import the worker functions by evaluating the relevant sections
const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'worker-github.js');
const workerSrc = fs.readFileSync(workerPath, 'utf8');

// Extract the filtering functions by evaluating them in a sandbox
// We need: shouldExcludeByOrigin, shouldExcludeByRuntime, shouldExcludeByUserPrefs

// Create a minimal context to extract the functions
const functionSrc = `
${workerSrc.match(/function shouldExcludeByOrigin[\s\S]*?^}/m)?.[0] || ''}
${workerSrc.match(/function shouldExcludeByRuntime[\s\S]*?^}/m)?.[0] || ''}
${workerSrc.match(/function shouldExcludeByUserPrefs[\s\S]*?^}/m)?.[0] || ''}
`;

// Evaluate the functions
const evalContext = {};
const fn = new Function('module', functionSrc + '\nmodule.exports = { shouldExcludeByOrigin, shouldExcludeByRuntime, shouldExcludeByUserPrefs };');
fn(evalContext);
const { shouldExcludeByOrigin, shouldExcludeByRuntime, shouldExcludeByUserPrefs } = evalContext.exports;

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    // console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.error(`  FAIL: ${name}`);
  }
}

console.log('=== Content Origin Filter Tests ===\n');

// Test: no config = no filtering
assert(shouldExcludeByOrigin({ countryOfOrigin: 'CN' }, {}) === false, 'No config = no filtering for CN');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'JP' }, {}) === false, 'No config = no filtering for JP');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'CN' }, { contentOrigins: [] }) === false, 'Empty origins = no filtering');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'CN' }, null) === false, 'Null config = no filtering');

// Test: JP-only filter
assert(shouldExcludeByOrigin({ countryOfOrigin: 'CN' }, { contentOrigins: ['JP'] }) === true, 'JP-only filter excludes CN');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'KR' }, { contentOrigins: ['JP'] }) === true, 'JP-only filter excludes KR');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'JP' }, { contentOrigins: ['JP'] }) === false, 'JP-only filter keeps JP');

// Test: JP+CN filter
assert(shouldExcludeByOrigin({ countryOfOrigin: 'CN' }, { contentOrigins: ['JP', 'CN'] }) === false, 'JP+CN filter keeps CN');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'KR' }, { contentOrigins: ['JP', 'CN'] }) === true, 'JP+CN filter excludes KR');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'JP' }, { contentOrigins: ['JP', 'CN'] }) === false, 'JP+CN filter keeps JP');

// Test: missing countryOfOrigin defaults to JP
assert(shouldExcludeByOrigin({}, { contentOrigins: ['JP'] }) === false, 'Missing origin defaults to JP, kept by JP filter');
assert(shouldExcludeByOrigin({}, { contentOrigins: ['CN'] }) === true, 'Missing origin defaults to JP, excluded by CN-only filter');
assert(shouldExcludeByOrigin({ countryOfOrigin: null }, { contentOrigins: ['JP'] }) === false, 'Null origin defaults to JP, kept by JP filter');

// Test: case insensitive
assert(shouldExcludeByOrigin({ countryOfOrigin: 'cn' }, { contentOrigins: ['JP', 'CN'] }) === false, 'Lowercase cn kept by JP+CN filter');
assert(shouldExcludeByOrigin({ countryOfOrigin: 'Cn' }, { contentOrigins: ['jp', 'cn'] }) === false, 'Mixed case works');

console.log('\n=== Minimum Runtime Filter Tests ===\n');

// Test: no config = no filtering
assert(shouldExcludeByRuntime({ runtime: '3 min' }, {}) === false, 'No config = no runtime filtering');
assert(shouldExcludeByRuntime({ runtime: '3 min' }, { minRuntime: 0 }) === false, 'minRuntime=0 = no filtering');
assert(shouldExcludeByRuntime({ runtime: '3 min' }, null) === false, 'Null config = no runtime filtering');

// Test: 15 min minimum
assert(shouldExcludeByRuntime({ runtime: '3 min' }, { minRuntime: 15 }) === true, '3 min < 15 min minimum = excluded');
assert(shouldExcludeByRuntime({ runtime: '10 min' }, { minRuntime: 15 }) === true, '10 min < 15 min minimum = excluded');
assert(shouldExcludeByRuntime({ runtime: '15 min' }, { minRuntime: 15 }) === false, '15 min = 15 min minimum = kept');
assert(shouldExcludeByRuntime({ runtime: '24 min' }, { minRuntime: 15 }) === false, '24 min > 15 min minimum = kept');
assert(shouldExcludeByRuntime({ runtime: '23 min' }, { minRuntime: 15 }) === false, '23 min > 15 min minimum = kept');

// Test: 22 min minimum (standard anime)
assert(shouldExcludeByRuntime({ runtime: '20 min' }, { minRuntime: 22 }) === true, '20 min < 22 min minimum = excluded');
assert(shouldExcludeByRuntime({ runtime: '22 min' }, { minRuntime: 22 }) === false, '22 min = 22 min minimum = kept');
assert(shouldExcludeByRuntime({ runtime: '24 min' }, { minRuntime: 22 }) === false, '24 min > 22 min minimum = kept');

// Test: movies are not filtered
assert(shouldExcludeByRuntime({ runtime: '3 min', subtype: 'movie' }, { minRuntime: 15 }) === false, 'Movie with 3 min runtime not filtered');
assert(shouldExcludeByRuntime({ runtime: '5 min', subtype: 'movie' }, { minRuntime: 22 }) === false, 'Movie with 5 min runtime not filtered');

// Test: no runtime data = not filtered
assert(shouldExcludeByRuntime({ runtime: null }, { minRuntime: 15 }) === false, 'Null runtime not filtered');
assert(shouldExcludeByRuntime({ runtime: undefined }, { minRuntime: 15 }) === false, 'Undefined runtime not filtered');
assert(shouldExcludeByRuntime({ runtime: '' }, { minRuntime: 15 }) === false, 'Empty string runtime not filtered');
assert(shouldExcludeByRuntime({}, { minRuntime: 15 }) === false, 'No runtime field not filtered');

// Test: numeric runtime
assert(shouldExcludeByRuntime({ runtime: 3 }, { minRuntime: 15 }) === true, 'Numeric 3 min < 15 min = excluded');
assert(shouldExcludeByRuntime({ runtime: 24 }, { minRuntime: 15 }) === false, 'Numeric 24 min > 15 min = kept');

console.log('\n=== Combined User Prefs Filter Tests ===\n');

// Test: both origin and runtime filters
assert(shouldExcludeByUserPrefs({ countryOfOrigin: 'CN', runtime: '3 min' }, { contentOrigins: ['JP'], minRuntime: 15 }) === true, 'CN + 3min excluded by JP-only + 15min filter');
assert(shouldExcludeByUserPrefs({ countryOfOrigin: 'JP', runtime: '24 min' }, { contentOrigins: ['JP'], minRuntime: 15 }) === false, 'JP + 24min kept by JP-only + 15min filter');
assert(shouldExcludeByUserPrefs({ countryOfOrigin: 'JP', runtime: '3 min' }, { contentOrigins: ['JP'], minRuntime: 15 }) === true, 'JP + 3min excluded by 15min filter (origin ok, runtime fails)');
assert(shouldExcludeByUserPrefs({ countryOfOrigin: 'CN', runtime: '24 min' }, { contentOrigins: ['JP'], minRuntime: 15 }) === true, 'CN + 24min excluded by JP-only filter (runtime ok, origin fails)');

// Test: no config
assert(shouldExcludeByUserPrefs({ countryOfOrigin: 'CN', runtime: '3 min' }, {}) === false, 'No config = no filtering');
assert(shouldExcludeByUserPrefs({ countryOfOrigin: 'CN', runtime: '3 min' }, null) === false, 'Null config = no filtering');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
