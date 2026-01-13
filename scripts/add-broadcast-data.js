#!/usr/bin/env node

/**
 * Add Broadcast Data to Existing Database
 * 
 * This script updates the existing catalog.json with broadcast day information
 * from Jikan API for all ONGOING anime. Much faster than a full rebuild.
 * 
 * Usage: node scripts/add-broadcast-data.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const CATALOG_GZ_PATH = path.join(DATA_DIR, 'catalog.json.gz');
const FILTER_OPTIONS_PATH = path.join(DATA_DIR, 'filter-options.json');

// Jikan API config
const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';
const JIKAN_RATE_LIMIT_MS = 400; // ~3 requests per second

// Helper to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch anime data from Jikan API by MAL ID
 */
async function fetchJikanAnime(malId) {
  try {
    const url = `${JIKAN_BASE_URL}/anime/${malId}`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      console.log(`    Rate limited, waiting 2 seconds...`);
      await sleep(2000);
      return fetchJikanAnime(malId);
    }
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data.data || null;
  } catch (error) {
    console.error(`    Error fetching Jikan data for MAL ${malId}:`, error.message);
    return null;
  }
}

/**
 * Search for anime on Jikan by name (returns full anime data including broadcast)
 */
async function searchJikanAnime(name) {
  try {
    // Clean name for search
    const cleanName = name.replace(/[^\w\s]/g, ' ').trim();
    const url = `${JIKAN_BASE_URL}/anime?q=${encodeURIComponent(cleanName)}&status=airing&limit=5`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      console.log(`    Rate limited, waiting 2 seconds...`);
      await sleep(2000);
      return searchJikanAnime(name);
    }
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    if (!data.data || data.data.length === 0) {
      return null;
    }
    
    // Find best match - prefer exact or close title match
    const nameLower = name.toLowerCase();
    const match = data.data.find(a => {
      const titles = [
        a.title?.toLowerCase(),
        a.title_english?.toLowerCase(),
        a.title_japanese,
        ...(a.title_synonyms || []).map(t => t.toLowerCase())
      ].filter(Boolean);
      
      return titles.some(t => t === nameLower || t.includes(nameLower) || nameLower.includes(t));
    });
    
    return match || data.data[0]; // Return best match or first result
  } catch (error) {
    console.error(`    Error searching Jikan for "${name}":`, error.message);
    return null;
  }
}

/**
 * Normalize weekday name
 */
function normalizeWeekday(day) {
  if (!day) return null;
  
  const normalized = day.toLowerCase().trim();
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  for (const weekday of weekdays) {
    if (normalized.includes(weekday)) {
      return weekday.charAt(0).toUpperCase() + weekday.slice(1);
    }
  }
  
  return null;
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('ADD BROADCAST DATA TO DATABASE');
  console.log('='.repeat(60));
  console.log();
  
  // Load existing catalog
  console.log('Loading existing catalog...');
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error('ERROR: catalog.json not found!');
    process.exit(1);
  }
  
  const data = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const catalog = data.catalog || data.anime || data;
  console.log(`Loaded ${catalog.length} anime`);
  console.log();
  
  // Find ALL ONGOING anime
  const ongoingAnime = catalog.filter(a => a.status === 'ONGOING');
  const withMalId = ongoingAnime.filter(a => a.mal_id);
  const withoutMalId = ongoingAnime.filter(a => !a.mal_id);
  
  console.log(`Found ${ongoingAnime.length} ONGOING anime total`);
  console.log(`  - ${withMalId.length} have MAL ID`);
  console.log(`  - ${withoutMalId.length} need MAL ID lookup`);
  console.log();
  
  // Track stats
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let malIdFound = 0;
  
  // PHASE 1: Process anime WITH mal_id
  console.log('PHASE 1: Fetching broadcast data for anime with MAL IDs...');
  console.log('-'.repeat(60));
  
  for (let i = 0; i < withMalId.length; i++) {
    const anime = withMalId[i];
    const progress = `[${i + 1}/${withMalId.length}]`;
    const title = anime.name || anime.title || 'Unknown';
    const malId = anime.mal_id;
    
    // Skip if already has broadcast day
    if (anime.broadcastDay) {
      console.log(`${progress} ${title} - already has broadcastDay: ${anime.broadcastDay}`);
      skipped++;
      continue;
    }
    
    console.log(`${progress} ${title} (MAL: ${malId})`);
    
    const animeData = await fetchJikanAnime(malId);
    
    if (animeData && animeData.broadcast?.day) {
      const weekday = normalizeWeekday(animeData.broadcast.day);
      if (weekday) {
        const idx = catalog.findIndex(a => (a.kitsu_id || a.kitsuId) === (anime.kitsu_id || anime.kitsuId));
        if (idx !== -1) {
          catalog[idx].broadcastDay = weekday;
          console.log(`    ✓ Set broadcastDay: ${weekday}`);
          updated++;
        }
      } else {
        console.log(`    ✗ Could not normalize day: ${animeData.broadcast.day}`);
        failed++;
      }
    } else {
      console.log(`    ✗ No broadcast data available`);
      failed++;
    }
    
    await sleep(JIKAN_RATE_LIMIT_MS);
  }
  
  // PHASE 2: Search for anime WITHOUT mal_id
  console.log();
  console.log('PHASE 2: Searching MAL for anime without MAL IDs...');
  console.log('-'.repeat(60));
  
  for (let i = 0; i < withoutMalId.length; i++) {
    const anime = withoutMalId[i];
    const progress = `[${i + 1}/${withoutMalId.length}]`;
    const title = anime.name || anime.title || 'Unknown';
    
    // Skip if already has broadcast day
    if (anime.broadcastDay) {
      console.log(`${progress} ${title} - already has broadcastDay: ${anime.broadcastDay}`);
      skipped++;
      continue;
    }
    
    console.log(`${progress} ${title} (searching...)`);
    
    const searchResult = await searchJikanAnime(title);
    
    if (searchResult) {
      const foundTitle = searchResult.title || searchResult.title_english;
      console.log(`    Found: ${foundTitle} (MAL: ${searchResult.mal_id})`);
      
      const idx = catalog.findIndex(a => (a.kitsu_id || a.kitsuId) === (anime.kitsu_id || anime.kitsuId));
      if (idx !== -1) {
        catalog[idx].mal_id = searchResult.mal_id;
        malIdFound++;
        
        if (searchResult.broadcast?.day) {
          const weekday = normalizeWeekday(searchResult.broadcast.day);
          if (weekday) {
            catalog[idx].broadcastDay = weekday;
            console.log(`    ✓ Set broadcastDay: ${weekday}`);
            updated++;
          } else {
            console.log(`    ✗ Could not normalize day: ${searchResult.broadcast.day}`);
            failed++;
          }
        } else {
          console.log(`    ✗ No broadcast data in search result`);
          failed++;
        }
      }
    } else {
      console.log(`    ✗ No search results found`);
      failed++;
    }
    
    await sleep(JIKAN_RATE_LIMIT_MS);
  }
  
  console.log();
  console.log('-'.repeat(60));
  console.log(`Results: ${updated} updated, ${skipped} skipped, ${failed} failed`);
  console.log(`MAL IDs found: ${malIdFound}`);
  console.log();
  
  // Update filter options with weekday counts
  console.log('Updating filter options with weekday counts...');
  
  const weekdayCounts = {};
  for (const anime of catalog) {
    if (anime.broadcastDay && anime.status === 'ONGOING') {
      weekdayCounts[anime.broadcastDay] = (weekdayCounts[anime.broadcastDay] || 0) + 1;
    }
  }
  
  console.log('Weekday counts:', weekdayCounts);
  
  if (fs.existsSync(FILTER_OPTIONS_PATH)) {
    const filterOptions = JSON.parse(fs.readFileSync(FILTER_OPTIONS_PATH, 'utf8'));
    filterOptions.weekdays = weekdayCounts;
    fs.writeFileSync(FILTER_OPTIONS_PATH, JSON.stringify(filterOptions, null, 2));
    console.log('✓ Updated filter-options.json');
  }
  
  // Update catalog metadata
  data.lastBroadcastUpdate = new Date().toISOString();
  
  // Save catalog.json
  console.log();
  console.log('Saving updated catalog...');
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(data, null, 2));
  console.log(`✓ Saved ${CATALOG_PATH}`);
  
  // Save compressed version
  const compressed = zlib.gzipSync(JSON.stringify(data));
  fs.writeFileSync(CATALOG_GZ_PATH, compressed);
  const sizeMB = (compressed.length / 1024 / 1024).toFixed(2);
  console.log(`✓ Saved ${CATALOG_GZ_PATH} (${sizeMB} MB)`);
  
  console.log();
  console.log('='.repeat(60));
  console.log('BROADCAST DATA UPDATE COMPLETE!');
  console.log('='.repeat(60));
  
  // Summary
  const totalWithBroadcast = catalog.filter(a => a.broadcastDay).length;
  const totalOngoing = catalog.filter(a => a.status === 'ONGOING').length;
  console.log();
  console.log('Summary:');
  console.log(`  Total anime: ${catalog.length}`);
  console.log(`  ONGOING anime: ${totalOngoing}`);
  console.log(`  Anime with broadcastDay: ${totalWithBroadcast}`);
  console.log();
  console.log('Weekday breakdown:');
  Object.entries(weekdayCounts)
    .sort((a, b) => {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      return days.indexOf(a[0]) - days.indexOf(b[0]);
    })
    .forEach(([day, count]) => {
      console.log(`  ${day}: ${count}`);
    });
}

main().catch(console.error);
