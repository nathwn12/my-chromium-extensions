'use strict';
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
