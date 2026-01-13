#!/usr/bin/env node

/**
 * Fix Airing Status in Database
 * 
 * This script updates the database to fix anime that are currently airing
 * but incorrectly marked as FINISHED. It fetches current status from Jikan API.
 * 
 * Usage: node scripts/fix-airing-status.js
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
const JIKAN_RATE_LIMIT_MS = 400;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Known currently airing anime that need status fix
 * Based on the anime schedule screenshots
 */
const KNOWN_AIRING_ANIME = [
  // From screenshots - these are confirmed currently airing
  'Blue Miburo',
  'To Your Eternity',
  'Jujutsu Kaisen',
  'Hell Teacher',
  'Jigoku Sensei Nube',
  'ROLL OVER AND DIE',
  'Koupen-chan',
  'Mrs. Sazae',
  'Sazae-san',
  'The Blue Orchestra',
  'Blue Orchestra',
  'Princess-Session Orchestra',
  'Himitsu no AiPri',
  'GANSO! BanG Dream',
  'Koala\'s Diary',
];

/**
 * Fetch anime status from Jikan API
 */
async function fetchJikanStatus(malId) {
  try {
    const url = `${JIKAN_BASE_URL}/anime/${malId}`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      console.log(`    Rate limited, waiting 2 seconds...`);
      await sleep(2000);
      return fetchJikanStatus(malId);
    }
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data.data || null;
  } catch (error) {
    console.error(`    Error fetching status for MAL ${malId}:`, error.message);
    return null;
  }
}

/**
 * Search for anime on Jikan
 */
async function searchJikanAnime(name) {
  try {
    const cleanName = name.replace(/[^\w\s]/g, ' ').trim();
    const url = `${JIKAN_BASE_URL}/anime?q=${encodeURIComponent(cleanName)}&limit=5`;
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
    
    // Find best match
    const nameLower = name.toLowerCase();
    const match = data.data.find(a => {
      const titles = [
        a.title?.toLowerCase(),
        a.title_english?.toLowerCase(),
        ...(a.title_synonyms || []).map(t => t.toLowerCase())
      ].filter(Boolean);
      return titles.some(t => t.includes(nameLower) || nameLower.includes(t));
    });
    
    return match || data.data[0];
  } catch (error) {
    console.error(`    Error searching for "${name}":`, error.message);
    return null;
  }
}

/**
 * Convert Jikan status to our status format
 */
function convertStatus(jikanStatus) {
  switch (jikanStatus?.toLowerCase()) {
    case 'currently airing':
      return 'ONGOING';
    case 'finished airing':
      return 'FINISHED';
    case 'not yet aired':
      return 'UPCOMING';
    default:
      return null;
  }
}

/**
 * Normalize weekday
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

async function main() {
  console.log('='.repeat(60));
  console.log('FIX AIRING STATUS IN DATABASE');
  console.log('='.repeat(60));
  console.log();
  
  // Load existing catalog
  console.log('Loading existing catalog...');
  const data = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const catalog = data.catalog;
  console.log(`Loaded ${catalog.length} anime`);
  console.log();
  
  // Track stats
  let statusFixed = 0;
  let broadcastAdded = 0;
  let malIdAdded = 0;
  
  // PHASE 1: Check known airing anime
  console.log('PHASE 1: Checking known currently airing anime...');
  console.log('-'.repeat(60));
  
  for (const knownName of KNOWN_AIRING_ANIME) {
    const matches = catalog.filter(a => 
      a.name && a.name.toLowerCase().includes(knownName.toLowerCase())
    );
    
    if (matches.length === 0) {
      console.log(`[SKIP] ${knownName} - not found in database`);
      continue;
    }
    
    for (const anime of matches) {
      console.log(`[CHECK] ${anime.name} (status: ${anime.status})`);
      
      // Search on Jikan to get current status
      const jikanData = anime.mal_id 
        ? await fetchJikanStatus(anime.mal_id)
        : await searchJikanAnime(anime.name);
      
      if (jikanData) {
        const newStatus = convertStatus(jikanData.status);
        const weekday = jikanData.broadcast?.day ? normalizeWeekday(jikanData.broadcast.day) : null;
        
        // Find index in catalog
        const idx = catalog.findIndex(a => a.kitsu_id === anime.kitsu_id);
        if (idx === -1) continue;
        
        // Update MAL ID if missing
        if (!catalog[idx].mal_id && jikanData.mal_id) {
          catalog[idx].mal_id = jikanData.mal_id;
          malIdAdded++;
          console.log(`    + Added MAL ID: ${jikanData.mal_id}`);
        }
        
        // Update status if different
        if (newStatus && newStatus !== anime.status) {
          console.log(`    ✓ Status: ${anime.status} → ${newStatus}`);
          catalog[idx].status = newStatus;
          statusFixed++;
        }
        
        // Update broadcast day
        if (weekday && !catalog[idx].broadcastDay) {
          catalog[idx].broadcastDay = weekday;
          broadcastAdded++;
          console.log(`    + Broadcast: ${weekday}`);
        }
      } else {
        console.log(`    ✗ Could not find on MAL`);
      }
      
      await sleep(JIKAN_RATE_LIMIT_MS);
    }
  }
  
  // PHASE 2: Check anime from 2024-2026 that might be airing
  console.log();
  console.log('PHASE 2: Checking recent anime (2024-2026) with MAL IDs...');
  console.log('-'.repeat(60));
  
  const recentAnime = catalog.filter(a => 
    a.year >= 2024 && 
    a.mal_id && 
    a.status !== 'ONGOING' &&
    !a.broadcastDay
  );
  
  console.log(`Found ${recentAnime.length} recent anime to check`);
  
  // Limit to avoid too many API calls
  const toCheck = recentAnime.slice(0, 100);
  
  for (let i = 0; i < toCheck.length; i++) {
    const anime = toCheck[i];
    const progress = `[${i + 1}/${toCheck.length}]`;
    
    const jikanData = await fetchJikanStatus(anime.mal_id);
    
    if (jikanData) {
      const newStatus = convertStatus(jikanData.status);
      const weekday = jikanData.broadcast?.day ? normalizeWeekday(jikanData.broadcast.day) : null;
      
      const idx = catalog.findIndex(a => a.kitsu_id === anime.kitsu_id);
      if (idx === -1) continue;
      
      let updated = false;
      
      if (newStatus === 'ONGOING' && anime.status !== 'ONGOING') {
        catalog[idx].status = newStatus;
        statusFixed++;
        updated = true;
      }
      
      if (weekday && !catalog[idx].broadcastDay) {
        catalog[idx].broadcastDay = weekday;
        broadcastAdded++;
        updated = true;
      }
      
      if (updated) {
        console.log(`${progress} ${anime.name} - Status: ${newStatus}, Broadcast: ${weekday || 'N/A'}`);
      }
    }
    
    await sleep(JIKAN_RATE_LIMIT_MS);
  }
  
  // Update filter options with weekday counts
  console.log();
  console.log('Updating filter options...');
  
  const weekdayCounts = {};
  const ongoingCount = catalog.filter(a => a.status === 'ONGOING').length;
  
  for (const anime of catalog) {
    if (anime.broadcastDay && anime.status === 'ONGOING') {
      weekdayCounts[anime.broadcastDay] = (weekdayCounts[anime.broadcastDay] || 0) + 1;
    }
  }
  
  // Create weekday options with counts
  const weekdayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const weekdaysWithCounts = weekdayOrder
    .filter(day => weekdayCounts[day] > 0)
    .map(day => `${day} (${weekdayCounts[day]})`);
  
  // Update filter-options.json
  if (fs.existsSync(FILTER_OPTIONS_PATH)) {
    const filterOptions = JSON.parse(fs.readFileSync(FILTER_OPTIONS_PATH, 'utf8'));
    filterOptions.weekdays = {
      withCounts: weekdaysWithCounts,
      list: weekdayOrder.filter(day => weekdayCounts[day] > 0),
      counts: weekdayCounts
    };
    fs.writeFileSync(FILTER_OPTIONS_PATH, JSON.stringify(filterOptions, null, 2));
    console.log('✓ Updated filter-options.json');
  }
  
  // Update catalog metadata
  data.lastStatusUpdate = new Date().toISOString();
  
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
  console.log('FIX COMPLETE!');
  console.log('='.repeat(60));
  console.log();
  console.log('Summary:');
  console.log(`  Status fixes: ${statusFixed}`);
  console.log(`  Broadcast days added: ${broadcastAdded}`);
  console.log(`  MAL IDs added: ${malIdAdded}`);
  console.log(`  Total ONGOING: ${catalog.filter(a => a.status === 'ONGOING').length}`);
  console.log();
  console.log('Weekday breakdown:');
  weekdayOrder.forEach(day => {
    if (weekdayCounts[day]) {
      console.log(`  ${day}: ${weekdayCounts[day]}`);
    }
  });
}

main().catch(console.error);
