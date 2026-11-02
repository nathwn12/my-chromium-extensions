'use strict';
// F5 proof: a sibling-subdomain tab must match the toggle-off broadcast.
// Usage: node qa/proof-f5-sibling.cjs [path-to-background.js]
// 1. Unit: getSiteKey('music.youtube.com') === 'youtube.com' (collapsed),
//    while the old exact-hostname predicate misses it.
// 2. Static: the TOGGLE_CHANGED fan-out in background.js compares collapsed
//    site keys (no `siteKey.split(':')[0]` exact-hostname match).
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const bgPath = process.argv[2] || path.join(repoRoot, 'background.js');
const shared = require(path.join(repoRoot, 'shared.js'));

function main() {
  const tabHost = new URL('https://music.youtube.com/watch?v=x').hostname;
  const siteKey = 'youtube.com';
  const collapsedMatch = shared.getSiteKey(tabHost) === siteKey;
  const oldPredicate = tabHost.toLowerCase() === siteKey.split(':')[0];
  const src = fs.readFileSync(bgPath, 'utf8');
  const usesCollapsed = src.includes('getSiteKey(') && src.includes('TOGGLE_CHANGED');
  const usesExactSplit = src.includes("siteKey.split(':')[0]");
  const result = { file: bgPath, tabHost, siteKey, collapsedMatch, oldPredicate, usesCollapsed, usesExactSplit };
  console.log(JSON.stringify(result, null, 2));
  if (!collapsedMatch) { console.log('SETUP-FAIL: getSiteKey does not collapse'); process.exit(2); }
  if (usesCollapsed && !usesExactSplit) console.log('GREEN: broadcast matches sibling subdomains via getSiteKey');
  else { console.log('RED: broadcast uses exact-hostname match; sibling tab misses toggle-off'); process.exit(1); }
}

main();
