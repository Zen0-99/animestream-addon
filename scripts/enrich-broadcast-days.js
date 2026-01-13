#!/usr/bin/env node
/**
 * Enrich Database with Broadcast Days from Jikan API
 * 
 * This script fetches broadcast day information from Jikan (MAL) API
 * for currently airing anime and updates the catalog.
 * 
 * Usage:
 *   node scripts/enrich-broadcast-days.js
 *   node scripts/enrich-broadcast-days.js --dry-run  # Preview without saving
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Jikan rate limit: 3 req/sec, 60 req/min
const REQUEST_DELAY = 400; // ms between requests

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Search Jikan for anime by title
 */
async function searchJikanByTitle(title) {
  const fetch = (await import('node-fetch')).default;
  
  // Clean title for search
  const searchTitle = title
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchTitle)}&limit=5&sfw=true`;
  
  try {
    const response = await fetch(url, { timeout: 15000 });
    
    if (response.status === 429) {
      console.log('   ⚠️  Rate limited, waiting 30s...');
      await sleep(30000);
      return searchJikanByTitle(title); // Retry
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    return data.data || [];
  } catch (err) {
    if (VERBOSE) console.log(`   ⚠️  Search failed for "${title}": ${err.message}`);
    return [];
  }
}

/**
 * Fetch full anime details from Jikan by MAL ID
 */
async function fetchJikanAnime(malId) {
  const fetch = (await import('node-fetch')).default;
  
  try {
    const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/full`, { timeout: 15000 });
    
    if (response.status === 429) {
      console.log('   ⚠️  Rate limited, waiting 30s...');
      await sleep(30000);
      return fetchJikanAnime(malId); // Retry
    }
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.data;
  } catch (err) {
    return null;
  }
}

/**
 * Extract broadcast day from Jikan anime data
 */
function extractBroadcastDay(jikanAnime) {
  if (!jikanAnime?.broadcast) return null;
  
  const dayStr = jikanAnime.broadcast.day;
  if (!dayStr) return null;
  
  // Jikan returns "Sundays", "Mondays", etc.
  // Convert to lowercase singular
  return dayStr.replace(/s$/i, '').toLowerCase();
}

/**
 * Match anime by title similarity
 */
function findBestMatch(targetTitle, results) {
  if (!results || results.length === 0) return null;
  
  const normalize = (str) => str.toLowerCase()
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const target = normalize(targetTitle);
  
  // First try: exact match
  for (const result of results) {
    const titles = [
      result.title,
      result.title_english,
      result.title_japanese,
      ...(result.title_synonyms || [])
    ].filter(Boolean);
    
    for (const t of titles) {
      if (normalize(t) === target) {
        return result;
      }
    }
  }
  
  // Second try: contains match
  for (const result of results) {
    const titles = [result.title, result.title_english].filter(Boolean);
    
    for (const t of titles) {
      const normalized = normalize(t);
      if (normalized.includes(target) || target.includes(normalized)) {
        return result;
      }
    }
  }
  
  // Third try: first airing result
  const airingResult = results.find(r => r.status === 'Currently Airing');
  if (airingResult) return airingResult;
  
  return null;
}

/**
 * Main enrichment function
 */
async function enrichBroadcastDays() {
  console.log('\n============================================================');
  console.log('       Broadcast Day Enrichment (from Jikan/MAL)');
  console.log('============================================================\n');
  
  if (DRY_RUN) console.log('🔍 DRY RUN - no changes will be saved\n');
  
  // Load existing catalog
  const catalogPath = path.join(__dirname, '..', 'data', 'catalog.json.gz');
  const catalogData = JSON.parse(zlib.gunzipSync(fs.readFileSync(catalogPath)));
  
  console.log(`📊 Loaded ${catalogData.catalog.length} anime from catalog\n`);
  
  // Filter to ONGOING anime only
  const ongoingAnime = catalogData.catalog.filter(a => a.status === 'ONGOING');
  console.log(`🔄 Processing ${ongoingAnime.length} ONGOING anime...\n`);
  
  let updated = 0;
  let failed = 0;
  const weekdayCounts = new Map();
  
  for (let i = 0; i < ongoingAnime.length; i++) {
    const anime = ongoingAnime[i];
    
    // Skip if already has broadcast day
    if (anime.broadcastDay) {
      const day = anime.broadcastDay.charAt(0).toUpperCase() + anime.broadcastDay.slice(1);
      weekdayCounts.set(day, (weekdayCounts.get(day) || 0) + 1);
      continue;
    }
    
    process.stdout.write(`\r   [${i + 1}/${ongoingAnime.length}] Searching: ${anime.name.substring(0, 40).padEnd(40)}`);
    
    let jikanAnime = null;
    
    // If we have MAL ID, use it directly
    if (anime.mal_id) {
      jikanAnime = await fetchJikanAnime(anime.mal_id);
    } else {
      // Search by title
      const results = await searchJikanByTitle(anime.name);
      const match = findBestMatch(anime.name, results);
      
      if (match) {
        jikanAnime = match;
        // Also save the MAL ID for future use
        anime.mal_id = match.mal_id;
      }
    }
    
    if (jikanAnime) {
      const broadcastDay = extractBroadcastDay(jikanAnime);
      
      if (broadcastDay) {
        anime.broadcastDay = broadcastDay;
        updated++;
        
        const day = broadcastDay.charAt(0).toUpperCase() + broadcastDay.slice(1);
        weekdayCounts.set(day, (weekdayCounts.get(day) || 0) + 1);
        
        if (VERBOSE) {
          console.log(`\n   ✓ ${anime.name} -> ${broadcastDay}`);
        }
      } else {
        failed++;
        if (VERBOSE) console.log(`\n   ✗ ${anime.name} - no broadcast day in Jikan`);
      }
    } else {
      failed++;
      if (VERBOSE) console.log(`\n   ✗ ${anime.name} - not found in Jikan`);
    }
    
    await sleep(REQUEST_DELAY);
  }
  
  console.log(`\n\n   ✅ Updated: ${updated}, Failed: ${failed}\n`);
  
  // Update weekday counts in filter options
  console.log('📋 Weekday distribution:');
  const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  for (const day of dayOrder) {
    const count = weekdayCounts.get(day) || 0;
    if (count > 0) {
      console.log(`   ${day}: ${count}`);
    }
  }
  
  if (!DRY_RUN) {
    // Update filter options
    const filterPath = path.join(__dirname, '..', 'data', 'filter-options.json');
    const filterOptions = JSON.parse(fs.readFileSync(filterPath, 'utf8'));
    
    filterOptions.weekdays = {
      withCounts: dayOrder
        .filter(day => weekdayCounts.has(day))
        .map(day => `${day} (${weekdayCounts.get(day)})`),
      list: dayOrder
        .filter(day => weekdayCounts.has(day))
        .map(day => ({ name: day, count: weekdayCounts.get(day) }))
    };
    
    fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
    console.log(`\n   ✅ Updated filter-options.json`);
    
    // Save catalog with broadcast days
    const jsonContent = JSON.stringify(catalogData, null, 2);
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'catalog.json'), jsonContent);
    fs.writeFileSync(catalogPath, zlib.gzipSync(jsonContent));
    console.log(`   ✅ Updated catalog.json.gz`);
  }
  
  console.log('\n============================================================\n');
}

// Run
enrichBroadcastDays().catch(err => {
  console.error('\n❌ Enrichment failed:', err.message);
  process.exit(1);
});
