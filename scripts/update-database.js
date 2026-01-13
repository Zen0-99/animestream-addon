#!/usr/bin/env node
/**
 * Incremental Database Update Script
 * 
 * Updates the anime database with new/changed content from Jikan API.
 * Much faster than full rebuild - only fetches currently airing anime.
 * 
 * Usage: node scripts/update-database.js
 *        node scripts/update-database.js --dry-run
 * 
 * This script:
 * 1. Loads existing catalog.json
 * 2. Fetches currently airing anime from Jikan
 * 3. Updates entries with new ratings/episodes
 * 4. Adds any new anime not in database
 * 5. Saves updated catalog
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Configuration
const CONFIG = {
  dataDir: path.join(__dirname, '..', 'data'),
  catalogFile: 'catalog.json',
  catalogGzFile: 'catalog.json.gz',
  filterOptionsFile: 'filter-options.json',
  
  jikan: {
    baseUrl: 'https://api.jikan.moe/v4',
    rateLimit: 3,        // requests per second
    delayBetweenRequests: 400, // ms
    maxPages: 10         // max pages to fetch
  }
};

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with retry and rate limiting
 */
async function fetchWithRetry(url, retries = 3) {
  const fetch = (await import('node-fetch')).default;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { timeout: 15000 });
      
      if (response.status === 429) {
        console.log(`   Rate limited, waiting 5s...`);
        await sleep(5000);
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (err) {
      if (i < retries - 1) {
        console.log(`   Retry ${i + 1}/${retries}: ${err.message}`);
        await sleep(1000);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Extract genres from Jikan response
 */
function extractGenres(jikanAnime) {
  const genres = [];
  
  for (const genre of jikanAnime.genres || []) {
    genres.push(genre.name);
  }
  for (const theme of jikanAnime.themes || []) {
    genres.push(theme.name);
  }
  
  return [...new Set(genres)].sort();
}

/**
 * Convert Jikan anime to our format
 */
function jikanToMeta(jikanAnime) {
  // Get season from aired dates
  let season = null;
  let year = null;
  
  if (jikanAnime.aired?.from) {
    const date = new Date(jikanAnime.aired.from);
    year = date.getFullYear();
    const month = date.getMonth();
    
    // Determine season from month
    if (month >= 0 && month <= 2) season = 'winter';
    else if (month >= 3 && month <= 5) season = 'spring';
    else if (month >= 6 && month <= 8) season = 'summer';
    else season = 'fall';
  }
  
  // Map status
  const statusMap = {
    'Currently Airing': 'ONGOING',
    'Finished Airing': 'FINISHED',
    'Not yet aired': 'UPCOMING'
  };
  
  // Map type
  const typeMap = {
    'TV': 'TV',
    'Movie': 'MOVIE',
    'OVA': 'OVA',
    'ONA': 'ONA',
    'Special': 'SPECIAL'
  };
  
  return {
    id: `mal-${jikanAnime.mal_id}`,
    malId: jikanAnime.mal_id,
    name: jikanAnime.title,
    poster: jikanAnime.images?.jpg?.large_image_url || jikanAnime.images?.jpg?.image_url,
    background: jikanAnime.images?.jpg?.large_image_url,
    rating: jikanAnime.score || null,
    year,
    season,
    releaseInfo: year?.toString(),
    animeType: typeMap[jikanAnime.type] || 'TV',
    status: statusMap[jikanAnime.status] || 'UNKNOWN',
    episodes: jikanAnime.episodes || null,
    genres: extractGenres(jikanAnime),
    studios: (jikanAnime.studios || []).map(s => s.name),
    aliases: jikanAnime.title_synonyms || []
  };
}

/**
 * Fetch currently airing anime from Jikan
 */
async function fetchAiringAnime() {
  console.log('\n📡 Fetching currently airing anime from Jikan...');
  
  const allAnime = [];
  let page = 1;
  
  while (page <= CONFIG.jikan.maxPages) {
    const url = `${CONFIG.jikan.baseUrl}/anime?status=airing&order_by=score&sort=desc&page=${page}`;
    
    try {
      if (VERBOSE) console.log(`   Fetching page ${page}...`);
      
      const data = await fetchWithRetry(url);
      
      if (!data.data || data.data.length === 0) {
        break;
      }
      
      allAnime.push(...data.data);
      console.log(`   Page ${page}: ${data.data.length} anime (total: ${allAnime.length})`);
      
      // Check if there are more pages
      if (!data.pagination?.has_next_page) {
        break;
      }
      
      page++;
      await sleep(CONFIG.jikan.delayBetweenRequests);
      
    } catch (err) {
      console.error(`   Error fetching page ${page}: ${err.message}`);
      break;
    }
  }
  
  return allAnime;
}

/**
 * Main update function
 */
async function updateDatabase() {
  const startTime = Date.now();
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           AnimeStream Incremental Update');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  
  // Load existing database
  const catalogPath = path.join(CONFIG.dataDir, CONFIG.catalogFile);
  
  if (!fs.existsSync(catalogPath)) {
    console.error('[ERR] catalog.json not found! Run: npm run build-db first');
    process.exit(1);
  }
  
  console.log('\n[LOAD] Loading existing database...');
  const database = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  console.log(`   Current entries: ${database.catalog.length}`);
  
  // Create lookup map
  const catalogMap = new Map();
  for (const anime of database.catalog) {
    catalogMap.set(anime.malId, anime);
  }
  
  // Fetch airing anime
  const airingAnime = await fetchAiringAnime();
  console.log(`   Fetched ${airingAnime.length} airing anime`);
  
  // Process updates
  console.log('\n[PROCESS] Processing updates...');
  
  let updated = 0;
  let added = 0;
  
  for (const jikanAnime of airingAnime) {
    const malId = jikanAnime.mal_id;
    const existing = catalogMap.get(malId);
    const newMeta = jikanToMeta(jikanAnime);
    
    if (existing) {
      // Update existing entry
      let hasChanges = false;
      
      // Update rating if changed
      if (newMeta.rating && newMeta.rating !== existing.rating) {
        if (VERBOSE) console.log(`   Updated rating: ${existing.name} (${existing.rating} -> ${newMeta.rating})`);
        existing.rating = newMeta.rating;
        hasChanges = true;
      }
      
      // Update episode count if changed
      if (newMeta.episodes && newMeta.episodes !== existing.episodes) {
        if (VERBOSE) console.log(`   Updated episodes: ${existing.name} (${existing.episodes} -> ${newMeta.episodes})`);
        existing.episodes = newMeta.episodes;
        hasChanges = true;
      }
      
      // Update status if changed
      if (newMeta.status !== existing.status) {
        if (VERBOSE) console.log(`   Updated status: ${existing.name} (${existing.status} -> ${newMeta.status})`);
        existing.status = newMeta.status;
        hasChanges = true;
      }
      
      if (hasChanges) updated++;
      
    } else {
      // Add new entry
      if (VERBOSE) console.log(`   New anime: ${newMeta.name}`);
      database.catalog.push(newMeta);
      catalogMap.set(malId, newMeta);
      added++;
    }
  }
  
  console.log(`\n[STATS] Update Summary:`);
  console.log(`   Updated: ${updated} anime`);
  console.log(`   Added: ${added} anime`);
  console.log(`   Total: ${database.catalog.length} anime`);
  
  if (DRY_RUN) {
    console.log('\n⚠️ DRY RUN - No changes saved');
  } else {
    // Sort by rating
    database.catalog.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    
    // Update metadata
    database.version = (database.version || 0) + 1;
    database.lastUpdate = new Date().toISOString();
    database.stats.totalAnime = database.catalog.length;
    
    // Save uncompressed
    console.log('\n[SAVE] Saving database...');
    fs.writeFileSync(catalogPath, JSON.stringify(database, null, 2));
    console.log(`   Saved: ${CONFIG.catalogFile}`);
    
    // Save compressed
    const gzPath = path.join(CONFIG.dataDir, CONFIG.catalogGzFile);
    const compressed = zlib.gzipSync(JSON.stringify(database));
    fs.writeFileSync(gzPath, compressed);
    console.log(`   Saved: ${CONFIG.catalogGzFile} (${(compressed.length / 1024 / 1024).toFixed(2)} MB)`);
    
    // Recalculate filter options
    console.log('\n[FILTERS] Updating filter options...');
    updateFilterOptions(database.catalog);
  }
  
  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[DONE] Update complete in ${duration}s`);
}

/**
 * Update filter-options.json with new counts
 */
function updateFilterOptions(catalog) {
  const genreCounts = new Map();
  const seasonCounts = new Map();
  const studioCounts = new Map();
  
  for (const anime of catalog) {
    // Count genres
    if (anime.genres) {
      for (const genre of anime.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }
    
    // Count seasons
    if (anime.year && anime.season) {
      const seasonKey = `${anime.year}-${anime.season.toLowerCase()}`;
      seasonCounts.set(seasonKey, (seasonCounts.get(seasonKey) || 0) + 1);
    }
    
    // Count studios
    if (anime.studios) {
      for (const studio of anime.studios) {
        studioCounts.set(studio, (studioCounts.get(studio) || 0) + 1);
      }
    }
  }
  
  // Format options
  const genreOptions = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([genre, count]) => `${genre} (${count})`);
  
  const seasonOptions = Array.from(seasonCounts.entries())
    .sort((a, b) => {
      const [yearA, seasonA] = a[0].split('-');
      const [yearB, seasonB] = b[0].split('-');
      if (yearA !== yearB) return parseInt(yearB) - parseInt(yearA);
      const seasonOrder = { winter: 4, fall: 3, summer: 2, spring: 1 };
      return (seasonOrder[seasonB] || 0) - (seasonOrder[seasonA] || 0);
    })
    .map(([season, count]) => {
      const [year, seasonName] = season.split('-');
      const display = `${year} - ${seasonName.charAt(0).toUpperCase() + seasonName.slice(1)}`;
      return `${display} (${count})`;
    });
  
  const studioOptions = Array.from(studioCounts.entries())
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([studio, count]) => `${studio} (${count})`);
  
  const filterOptions = {
    genres: {
      withCounts: genreOptions,
      values: Array.from(genreCounts.keys()).sort()
    },
    seasons: {
      withCounts: seasonOptions,
      values: Array.from(seasonCounts.keys()).sort().reverse()
    },
    studios: {
      withCounts: studioOptions,
      values: Array.from(studioCounts.keys()).sort()
    }
  };
  
  const filterPath = path.join(CONFIG.dataDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   Updated: ${CONFIG.filterOptionsFile}`);
}

// Run
updateDatabase().catch(err => {
  console.error('Update failed:', err);
  process.exit(1);
});
