#!/usr/bin/env node

/**
 * Build Cloudflare Worker
 * 
 * This script:
 * 1. Reads the catalog.json and filter-options.json
 * 2. Embeds them into the worker template
 * 3. Outputs the final worker.js ready for deployment
 * 
 * Usage: node build-worker.js
 */

const fs = require('fs');
const path = require('path');

const WORKER_DIR = __dirname;
const DATA_DIR = path.join(__dirname, '..', 'data');

const TEMPLATE_PATH = path.join(WORKER_DIR, 'worker.template.js');
const OUTPUT_PATH = path.join(WORKER_DIR, 'worker.js');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const FILTER_OPTIONS_PATH = path.join(DATA_DIR, 'filter-options.json');

console.log('='.repeat(50));
console.log('Building Cloudflare Worker');
console.log('='.repeat(50));

// Load data files
console.log('\nLoading data files...');

const catalogData = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const filterOptions = JSON.parse(fs.readFileSync(FILTER_OPTIONS_PATH, 'utf8'));

console.log(`  Catalog: ${catalogData.catalog.length} anime`);
console.log(`  Filter options loaded`);

// Load template
console.log('\nLoading worker template...');
let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// Replace placeholders with actual data
console.log('Embedding data into worker...');

// Embed catalog (just the array, not the wrapper)
const catalogJson = JSON.stringify(catalogData.catalog);
template = template.replace('__CATALOG_DATA__', catalogJson);

// Embed filter options
const filterJson = JSON.stringify(filterOptions);
template = template.replace('__FILTER_OPTIONS__', filterJson);

// Write output
fs.writeFileSync(OUTPUT_PATH, template);

const fileSizeKB = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(2);
const fileSizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2);

console.log(`\n✓ Worker built successfully!`);
console.log(`  Output: ${OUTPUT_PATH}`);
console.log(`  Size: ${fileSizeKB} KB (${fileSizeMB} MB)`);

// Check if within Cloudflare limits (25MB for bundled workers)
const maxSizeMB = 25;
if (parseFloat(fileSizeMB) > maxSizeMB) {
  console.log(`\n⚠️  WARNING: Worker exceeds ${maxSizeMB}MB Cloudflare limit!`);
  console.log(`   Consider compressing catalog data or using KV storage.`);
} else {
  console.log(`\n✓ Within Cloudflare ${maxSizeMB}MB limit`);
}

console.log('\nTo deploy:');
console.log('  cd cloudflare-worker');
console.log('  npx wrangler deploy');
