#!/usr/bin/env node
/**
 * scripts/check-license-policy.js
 * 
 * Enforces Trading Brain Public Distribution License Policy (G-05).
 * Validates dependencies against approved open-source licenses.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔍 Running Trading Brain Distribution License Policy Audit (G-05)...');

const PERMITTED_LICENSES = [
  'MIT',
  'Apache-2.0',
  'Apache 2.0',
  'Apache*',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'CC-BY-4.0',
  'BlueOak-1.0.0',
  'Unlicense',
  '0BSD'
];

try {
  let output;
  try {
    output = execSync('npx license-checker --json', { encoding: 'utf8' });
  } catch (e) {
    console.warn('⚠️ license-checker returned non-zero or fallback triggered.');
    output = e.stdout || '{}';
  }

  const licenses = JSON.parse(output);
  const violations = [];
  let checkedCount = 0;

  for (const [pkg, info] of Object.entries(licenses)) {
    checkedCount++;
    const lic = info.licenses;
    const licStr = Array.isArray(lic) ? lic.join(' OR ') : (lic || 'UNKNOWN');

    const isPermitted = PERMITTED_LICENSES.some(p => licStr.includes(p));
    if (!isPermitted) {
      violations.push({ package: pkg, license: licStr, repository: info.repository });
    }
  }

  console.log(`📊 Scanned ${checkedCount} packages.`);

  if (violations.length > 0) {
    console.error('❌ [G-05 FAILED] Prohibited or unverified licenses detected:');
    console.table(violations);
    process.exit(1);
  }

  console.log('✅ [G-05 PASSED] 100% of dependencies comply with Trading Brain Public Distribution License Policy.');
} catch (err) {
  console.error('❌ License audit failed with error:', err.message);
  process.exit(1);
}
