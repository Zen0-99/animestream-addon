#!/usr/bin/env node
/**
 * Anime Kitsu Database Builder
 * 
 * Builds anime database from Anime Kitsu addon + Fribb mappings + Cinemeta enrichment.
 * 
 * Features:
 * - Uses Anime Kitsu addon for comprehensive anime catalog
 * - Enriches with Fribb/anime-lists for MAL/IMDB mappings
 * - Groups seasons into single entries (Baki Season 1-4 → Baki)
 * - Only includes anime with valid IMDB IDs
 * - Fetches episode data from Cinemeta
 * 
 * Usage:
 *   node scripts/build-database-kitsu.js           # Full build
 *   node scripts/build-database-kitsu.js --test    # Test mode (200 anime)
 *   node scripts/build-database-kitsu.js --skip-episodes  # Skip Cinemeta episode fetch
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const TEST_MODE = process.argv.includes('--test');
const SKIP_EPISODES = process.argv.includes('--skip-episodes');
const TEST_LIMIT = 200;

const CONFIG = {
  outputDir: path.join(__dirname, '..', 'data'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  catalogGzFile: TEST_MODE ? 'catalog-test.json.gz' : 'catalog.json.gz',
  filterOptionsFile: 'filter-options.json',
  
  // API endpoints
  kitsuUrl: 'https://anime-kitsu.strem.fun',
  cinemetaUrl: 'https://v3-cinemeta.strem.io',
  fribbUrl: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  
  // Catalogs to fetch from Kitsu (in priority order)
  kitsuCatalogs: [
    'kitsu-anime-popular',
    'kitsu-anime-rating',
    'kitsu-anime-trending',
    'kitsu-anime-airing'
  ],
  
  // Rate limiting
  requestDelay: 100, // ms between requests
  cinemetaDelay: 200  // ms between Cinemeta requests (be nice)
};

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Progress bar helper
 */
function progressBar(current, total, width = 30) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${percent}% (${current}/${total})`;
}

/**
 * Format file size
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Fetch with retry and timeout
 */
async function fetchJson(url, retries = 3) {
  const fetch = (await import('node-fetch')).default;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { timeout: 30000 });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`   Retry ${i + 1}/${retries}: ${err.message}`);
      await sleep(2000 * (i + 1));
    }
  }
}

/**
 * Load Fribb anime-lists mappings
 */
async function loadFribbMappings() {
  console.log('\n[FRIBB] Loading anime-lists mappings...');
  
  try {
    const data = await fetchJson(CONFIG.fribbUrl);
    
    // Build lookup maps
    const malToImdb = new Map();
    const malToData = new Map();
    const kitsuToMal = new Map();
    const imdbToMal = new Map();
    
    for (const entry of data) {
      if (entry.mal_id) {
        if (entry.imdb_id) {
          malToImdb.set(entry.mal_id, entry.imdb_id);
          imdbToMal.set(entry.imdb_id, entry.mal_id);
        }
        malToData.set(entry.mal_id, entry);
      }
      if (entry.kitsu_id && entry.mal_id) {
        kitsuToMal.set(entry.kitsu_id, entry.mal_id);
      }
    }
    
    console.log(`   Loaded ${data.length} entries`);
    console.log(`   MAL→IMDB mappings: ${malToImdb.size}`);
    console.log(`   Kitsu→MAL mappings: ${kitsuToMal.size}`);
    
    return { malToImdb, malToData, kitsuToMal, imdbToMal, raw: data };
  } catch (err) {
    console.log(`   [WARN] Failed to load Fribb mappings: ${err.message}`);
    return { malToImdb: new Map(), malToData: new Map(), kitsuToMal: new Map(), imdbToMal: new Map(), raw: [] };
  }
}

/**
 * Fetch all anime from Kitsu addon catalogs
 */
async function fetchKitsuCatalog() {
  console.log('\n[KITSU] Fetching anime catalog...');
  
  const seenIds = new Set();
  const allAnime = [];
  
  for (const catalog of CONFIG.kitsuCatalogs) {
    console.log(`   Catalog: ${catalog}`);
    let skip = 0;
    let pageNum = 1;
    let emptyPages = 0;
    
    while (emptyPages < 2) { // Stop after 2 empty pages
      try {
        const url = skip === 0 
          ? `${CONFIG.kitsuUrl}/catalog/anime/${catalog}.json`
          : `${CONFIG.kitsuUrl}/catalog/anime/${catalog}/skip=${skip}.json`;
        
        const data = await fetchJson(url);
        const metas = data.metas || [];
        
        if (metas.length === 0) {
          emptyPages++;
          skip += 20;
          continue;
        }
        
        emptyPages = 0;
        
        for (const meta of metas) {
          // Use IMDB ID as unique key, fall back to kitsu_id
          const uniqueId = meta.imdb_id || meta.id;
          if (!seenIds.has(uniqueId)) {
            seenIds.add(uniqueId);
            allAnime.push(meta);
          }
        }
        
        process.stdout.write(`\r   Page ${pageNum}: ${allAnime.length} unique anime`);
        
        if (TEST_MODE && allAnime.length >= TEST_LIMIT) {
          console.log(`\n   TEST MODE: Stopping at ${TEST_LIMIT} anime`);
          return allAnime.slice(0, TEST_LIMIT);
        }
        
        skip += 20;
        pageNum++;
        await sleep(CONFIG.requestDelay);
        
      } catch (err) {
        console.log(`\n   [ERR] Page ${pageNum}: ${err.message}`);
        emptyPages++;
        skip += 20;
      }
    }
    console.log('');
  }
  
  console.log(`   Total unique anime: ${allAnime.length}`);
  return allAnime;
}

/**
 * Extract base series name (remove "Season X", "Part X", etc.)
 */
function getBaseSeriesName(title) {
  if (!title) return '';
  
  // Patterns to remove for grouping
  const patterns = [
    /\s*[\(\[]?(Season|Part|Cour|Chapter)\s*\d+[\)\]]?\s*$/i,
    /\s*[\(\[]?S\d+[\)\]]?\s*$/i,
    /\s*\d+(st|nd|rd|th)\s*(Season|Part|Cour)\s*$/i,
    /\s*II+\s*$/,  // Roman numerals at end
    /\s*:\s*(Second|Third|Fourth|Fifth|Final)\s*(Season|Part)?\s*$/i,
    /\s*-\s*(2nd|3rd|4th|5th)\s*(Season|Part)?\s*$/i,
  ];
  
  let baseName = title.trim();
  for (const pattern of patterns) {
    baseName = baseName.replace(pattern, '').trim();
  }
  
  return baseName;
}

/**
 * Extract season number from title
 */
function extractSeasonNumber(title) {
  if (!title) return 1;
  
  const patterns = [
    /Season\s*(\d+)/i,
    /Part\s*(\d+)/i,
    /Cour\s*(\d+)/i,
    /S(\d+)(?:\s|$)/i,
    /(\d+)(?:st|nd|rd|th)\s*Season/i,
  ];
  
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  
  // Roman numerals
  if (/\s+II\s*$/.test(title)) return 2;
  if (/\s+III\s*$/.test(title)) return 3;
  if (/\s+IV\s*$/.test(title)) return 4;
  
  return 1;
}

/**
 * Group anime by base series name
 */
function groupSeasons(animeList, fribbMappings) {
  console.log('\n[GROUP] Grouping seasons...');
  
  const groups = new Map(); // baseName -> array of entries
  const imdbToGroup = new Map(); // IMDB ID -> group key
  
  for (const anime of animeList) {
    const baseName = getBaseSeriesName(anime.name);
    const seasonNum = extractSeasonNumber(anime.name);
    
    // If anime has IMDB ID, check if we've seen this IMDB before
    if (anime.imdb_id && imdbToGroup.has(anime.imdb_id)) {
      // This IMDB ID is already in a group, skip duplicate
      continue;
    }
    
    // Add to group
    if (!groups.has(baseName)) {
      groups.set(baseName, []);
    }
    
    groups.get(baseName).push({
      ...anime,
      _seasonNum: seasonNum,
      _baseName: baseName
    });
    
    if (anime.imdb_id) {
      imdbToGroup.set(anime.imdb_id, baseName);
    }
  }
  
  // Merge each group into a single entry
  const merged = [];
  let groupedCount = 0;
  let skippedNoImdb = 0;
  
  for (const [baseName, entries] of groups) {
    // Sort by season number
    entries.sort((a, b) => a._seasonNum - b._seasonNum);
    
    // Use first season's data as base (usually has best metadata)
    const primary = entries[0];
    
    // Find best IMDB ID (prefer from first season)
    let bestImdbId = null;
    for (const entry of entries) {
      if (entry.imdb_id) {
        bestImdbId = entry.imdb_id;
        break;
      }
    }
    
    // Skip if no IMDB ID
    if (!bestImdbId) {
      skippedNoImdb += entries.length;
      continue;
    }
    
    // Collect all genres from all seasons
    const allGenres = new Set();
    for (const entry of entries) {
      if (entry.genres) {
        entry.genres.forEach(g => allGenres.add(g));
      }
    }
    
    // Collect all aliases
    const allAliases = new Set();
    for (const entry of entries) {
      if (entry.aliases) {
        entry.aliases.forEach(a => allAliases.add(a));
      }
      // Add original name if different from base
      if (entry.name && entry.name !== baseName) {
        allAliases.add(entry.name);
      }
    }
    
    // Determine total seasons
    const maxSeason = Math.max(...entries.map(e => e._seasonNum));
    
    // Build merged entry
    const mergedEntry = {
      id: bestImdbId, // Use IMDB as primary ID
      imdb_id: bestImdbId,
      name: baseName,
      type: 'series',
      poster: primary.poster,
      background: primary.background,
      logo: primary.logo,
      description: primary.description,
      releaseInfo: primary.releaseInfo || primary.year,
      year: primary.year,
      imdbRating: primary.imdbRating,
      genres: Array.from(allGenres).filter(g => g).slice(0, 10),
      aliases: Array.from(allAliases).filter(a => a),
      runtime: primary.runtime,
      status: primary.status,
      _totalSeasons: maxSeason,
      _mergedFrom: entries.length,
      // Keep Kitsu/MAL IDs for reference
      kitsu_id: primary.kitsu_id,
      mal_id: primary.mal_id
    };
    
    // Try to get MAL ID from Fribb if not present
    if (!mergedEntry.mal_id && fribbMappings.imdbToMal.has(bestImdbId)) {
      mergedEntry.mal_id = fribbMappings.imdbToMal.get(bestImdbId);
    }
    
    merged.push(mergedEntry);
    
    if (entries.length > 1) {
      groupedCount++;
    }
  }
  
  console.log(`   Groups created: ${groups.size}`);
  console.log(`   Multi-season series merged: ${groupedCount}`);
  console.log(`   Skipped (no IMDB): ${skippedNoImdb}`);
  console.log(`   Final entries: ${merged.length}`);
  
  return merged;
}

/**
 * Fetch additional metadata from Cinemeta (episodes, better descriptions)
 */
async function enrichWithCinemeta(animeList) {
  if (SKIP_EPISODES) {
    console.log('\n[CINEMETA] Skipping episode enrichment (--skip-episodes)');
    return animeList;
  }
  
  console.log('\n[CINEMETA] Enriching with episode data...');
  
  const enriched = [];
  let successCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < animeList.length; i++) {
    const anime = animeList[i];
    process.stdout.write(`\r   ${progressBar(i + 1, animeList.length)} - ${successCount} enriched`);
    
    if (!anime.imdb_id) {
      enriched.push(anime);
      continue;
    }
    
    try {
      const url = `${CONFIG.cinemetaUrl}/meta/series/${anime.imdb_id}.json`;
      const data = await fetchJson(url);
      
      if (data.meta) {
        // Merge Cinemeta data
        enriched.push({
          ...anime,
          description: data.meta.description || anime.description,
          background: data.meta.background || anime.background,
          logo: data.meta.logo || anime.logo,
          runtime: data.meta.runtime || anime.runtime,
          cast: data.meta.cast,
          director: data.meta.director,
          writer: data.meta.writer,
          trailers: data.meta.trailers,
          videos: data.meta.videos, // Episode data!
          _cinemetaEnriched: true
        });
        successCount++;
      } else {
        enriched.push(anime);
      }
    } catch (err) {
      enriched.push(anime);
      errorCount++;
    }
    
    await sleep(CONFIG.cinemetaDelay);
  }
  
  console.log(`\n   Enriched: ${successCount}, Errors: ${errorCount}`);
  return enriched;
}

/**
 * Build filter options from anime list
 */
function buildFilterOptions(animeList) {
  console.log('\n[FILTERS] Building filter options...');
  
  const genreCounts = new Map();
  const yearCounts = new Map();
  const statusCounts = new Map();
  
  for (const anime of animeList) {
    // Genres
    if (anime.genres) {
      for (const genre of anime.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }
    
    // Years
    const year = anime.year || anime.releaseInfo?.match(/\d{4}/)?.[0];
    if (year) {
      yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
    }
    
    // Status
    if (anime.status) {
      statusCounts.set(anime.status, (statusCounts.get(anime.status) || 0) + 1);
    }
  }
  
  // Sort and format
  const genres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  
  const years = Array.from(yearCounts.entries())
    .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
    .map(([year, count]) => ({ year, count }));
  
  console.log(`   Genres: ${genres.length}`);
  console.log(`   Years: ${years.length}`);
  
  return { genres, years, statuses: Object.fromEntries(statusCounts) };
}

/**
 * Write output files
 */
function writeOutput(catalog, filterOptions) {
  console.log('\n[WRITE] Writing output files...');
  
  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  const output = {
    version: '2.0.0',
    source: 'anime-kitsu+fribb+cinemeta',
    buildDate: new Date().toISOString(),
    totalAnime: catalog.length,
    catalog: catalog
  };
  
  // Write uncompressed JSON
  const jsonPath = path.join(CONFIG.outputDir, CONFIG.catalogFile);
  const jsonContent = JSON.stringify(output, null, 2);
  fs.writeFileSync(jsonPath, jsonContent);
  console.log(`   ${CONFIG.catalogFile}: ${formatSize(jsonContent.length)}`);
  
  // Write compressed gzip
  const gzPath = path.join(CONFIG.outputDir, CONFIG.catalogGzFile);
  const gzContent = zlib.gzipSync(jsonContent);
  fs.writeFileSync(gzPath, gzContent);
  const compression = Math.round((1 - gzContent.length / jsonContent.length) * 100);
  console.log(`   ${CONFIG.catalogGzFile}: ${formatSize(gzContent.length)} (${compression}% compression)`);
  
  // Write filter options
  const filterPath = path.join(CONFIG.outputDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   ${CONFIG.filterOptionsFile}: ${formatSize(fs.statSync(filterPath).size)}`);
}

/**
 * Main build process
 */
async function main() {
  const startTime = Date.now();
  
  console.log('============================================================');
  console.log('       AnimeStream Kitsu Database Builder');
  console.log('============================================================');
  console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'FULL'}`);
  console.log(`Episodes: ${SKIP_EPISODES ? 'SKIP' : 'FETCH'}`);
  console.log(`Output: ${CONFIG.outputDir}`);
  
  try {
    // Step 1: Load Fribb mappings
    const fribbMappings = await loadFribbMappings();
    
    // Step 2: Fetch anime from Kitsu
    const kitsuAnime = await fetchKitsuCatalog();
    
    // Step 3: Group seasons
    const grouped = groupSeasons(kitsuAnime, fribbMappings);
    
    // Step 4: Sort by rating
    grouped.sort((a, b) => {
      const ratingA = parseFloat(a.imdbRating) || 0;
      const ratingB = parseFloat(b.imdbRating) || 0;
      return ratingB - ratingA;
    });
    
    // Step 5: Enrich with Cinemeta (optional)
    const enriched = await enrichWithCinemeta(grouped);
    
    // Step 6: Build filter options
    const filterOptions = buildFilterOptions(enriched);
    
    // Step 7: Write output
    writeOutput(enriched, filterOptions);
    
    // Done!
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('\n============================================================');
    console.log(`[DONE] Database built in ${elapsed}s`);
    console.log(`       Total anime: ${enriched.length}`);
    console.log(`       All entries have IMDB IDs (streams will work!)`);
    console.log('============================================================');
    
  } catch (err) {
    console.error('\n[FATAL ERROR]', err);
    process.exit(1);
  }
}

// Run
main();
