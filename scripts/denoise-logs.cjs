#!/usr/bin/env node
// Removes noisy stack trace lines from console logs

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || path.join(__dirname, '../temp/console.log');
const outputFile = process.argv[3] || inputFile;

const NOISE_PATTERNS = [
  /^requestAnimationFrame$/,
  /^render2 @ CesiumWidget\.js:\d+$/,
  /^Event\.raiseEvent @ Event\.js:\d+$/,
  /^Scene4\.render @ Scene\.js:\d+$/,
  /^CesiumWidget\.render @ CesiumWidget\.js:\d+$/,
  /^\(anonymous\) @ \S+:\d+$/,
  /^logMetrics @ performanceMonitor\.ts:\d+$/,
  /^oneTimeWarning @ cesium\.js\?v=\w+:\d+$/,
  /^loadModsOfType @ ModService\.ts:\d+$/,
];

const content = fs.readFileSync(inputFile, 'utf-8');
const lines = content.split('\n');

// Remove line number prefix (e.g., "   123→") and check against patterns
const filtered = lines.filter(line => {
  const stripped = line.replace(/^\s*\d+→/, '').trim();
  return !NOISE_PATTERNS.some(pattern => pattern.test(stripped));
});

fs.writeFileSync(outputFile, filtered.join('\n'));
console.log(`Removed ${lines.length - filtered.length} noisy lines (${lines.length} -> ${filtered.length})`);
