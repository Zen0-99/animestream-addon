#!/usr/bin/env node
/**
 * AnimeStream Database Builder v2
 * 
 * Sources:
 * 1. Kitsu API - Full anime catalog (21,000+ entries) with genres
 * 2. Fribb/anime-lists - IMDB/TMDB/TVDB mappings
 * 
 * Features:
 * - Season grouping using IMDB ID (all seasons share same IMDB)
 * - IMDB filtering (only includes anime with IMDB IDs)
 * - Hentaistream-style progress display
 * - Genre fetching included in main query
 * 
 * Usage:
 *   node scripts/build-database-v2.js          # Full build
 *   node scripts/build-database-v2.js --test   # Test mode (500 items)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// TEST MODE: Run with --test flag to only fetch limited items
const TEST_MODE = process.argv.includes('--test');
const TEST_LIMIT = 500;

// Configuration
const CONFIG = {
  outputDir: path.join(__dirname, '..', 'data'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  catalogGzFile: TEST_MODE ? 'catalog-test.json.gz' : 'catalog.json.gz',
  filterOptionsFile: 'filter-options.json',
  
  // Kitsu API
  kitsuBaseUrl: 'https://kitsu.io/api/edge',
  kitsuPageSize: 20, // Max allowed by Kitsu
  
  // Fribb mappings
  fribbUrl: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  
  // Rate limiting
  requestDelay: 150, // ms between requests
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function progressBar(current, total, width = 30) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${percent}% (${current}/${total})`;
}

// ============================================================
// KITSU API
// ============================================================

async function kitsuRequest(endpoint, retries = 3) {
  const fetch = (await import('node-fetch')).default;
  const url = endpoint.startsWith('http') ? endpoint : `${CONFIG.kitsuBaseUrl}${endpoint}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/vnd.api+json' },
        timeout: 30000
      });
      
      if (response.status === 429) {
        console.log('\n   ⚠️  Rate limited, waiting 30s...');
        await sleep(30000);
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

/**
 * Fetch ALL anime from Kitsu API with pagination (includes genres)
 */
async function fetchAllKitsuAnime() {
  console.log('\n📥 Fetching anime from Kitsu API (with genres)...');
  console.log('   Total available: ~21,859 anime\n');
  
  const allAnime = [];
  const genreMap = new Map(); // id -> genre name
  let offset = 0;
  let totalCount = null;
  
  while (true) {
    try {
      // Include genres to avoid extra API calls
      const data = await kitsuRequest(
        `/anime?page[limit]=${CONFIG.kitsuPageSize}&page[offset]=${offset}&sort=-userCount&include=genres`
      );
      
      if (totalCount === null) {
        totalCount = TEST_MODE ? Math.min(data.meta.count, TEST_LIMIT) : data.meta.count;
      }
      
      // Build genre map from included data
      if (data.included) {
        for (const item of data.included) {
          if (item.type === 'genres') {
            genreMap.set(item.id, item.attributes.name);
          }
        }
      }
      
      // Process anime with their genre IDs resolved
      for (const anime of data.data) {
        const genreIds = anime.relationships?.genres?.data?.map(g => g.id) || [];
        anime._genres = genreIds.map(id => genreMap.get(id)).filter(Boolean);
        allAnime.push(anime);
      }
      
      // Progress display
      const progress = Math.min(allAnime.length, totalCount);
      process.stdout.write(`\r   ${progressBar(progress, totalCount)} - ${allAnime.length} fetched`);
      
      // Check if done
      if (!data.links.next || allAnime.length >= totalCount) {
        break;
      }
      
      offset += CONFIG.kitsuPageSize;
      await sleep(CONFIG.requestDelay);
      
    } catch (err) {
      console.log(`\n   ⚠️  Error at offset ${offset}: ${err.message}, retrying...`);
      await sleep(5000);
    }
  }
  
  console.log(`\n   ✅ Fetched ${allAnime.length} anime from Kitsu\n`);
  return allAnime;
}

/**
 * Fetch Kitsu mappings for an anime (MAL ID, TVDB, etc.)
 */
async function fetchKitsuMappings(kitsuId) {
  try {
    const data = await kitsuRequest(`/anime/${kitsuId}/mappings`);
    const mappings = {};
    
    for (const mapping of data.data) {
      const site = mapping.attributes.externalSite;
      const id = mapping.attributes.externalId;
      
      if (site === 'myanimelist/anime') mappings.mal_id = parseInt(id, 10);
      if (site === 'thetvdb' || site === 'thetvdb/series') mappings.tvdb_id = parseInt(id, 10);
      if (site === 'anilist/anime') mappings.anilist_id = parseInt(id, 10);
      if (site === 'anidb') mappings.anidb_id = parseInt(id, 10);
    }
    
    return mappings;
  } catch (err) {
    return {};
  }
}

// ============================================================
// FRIBB MAPPINGS (MAL -> IMDB)
// ============================================================

async function loadFribbMappings() {
  console.log('📥 Loading Fribb/anime-lists mappings...');
  
  const fetch = (await import('node-fetch')).default;
  
  try {
    const response = await fetch(CONFIG.fribbUrl, { timeout: 60000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const mappings = await response.json();
    
    // Build lookup maps
    const malToImdb = new Map();
    const malToTmdb = new Map();
    const kitsuToImdb = new Map();
    
    for (const entry of mappings) {
      if (entry.mal_id && entry.imdb_id) {
        malToImdb.set(entry.mal_id, entry.imdb_id);
      }
      if (entry.mal_id && entry.themoviedb_id) {
        malToTmdb.set(entry.mal_id, entry.themoviedb_id);
      }
      if (entry.kitsu_id && entry.imdb_id) {
        kitsuToImdb.set(entry.kitsu_id, entry.imdb_id);
      }
    }
    
    console.log(`   ✅ Loaded ${mappings.length} mappings`);
    console.log(`   📊 MAL→IMDB: ${malToImdb.size}, Kitsu→IMDB: ${kitsuToImdb.size}\n`);
    
    return { malToImdb, malToTmdb, kitsuToImdb };
  } catch (err) {
    console.error(`   ❌ Failed to load Fribb mappings: ${err.message}\n`);
    return { malToImdb: new Map(), malToTmdb: new Map(), kitsuToImdb: new Map() };
  }
}

// ============================================================
// SEASON GROUPING BY IMDB ID
// ============================================================

/**
 * Extract clean base title for display
 */
function extractBaseTitle(title) {
  if (!title) return '';
  
  return title
    // Remove season indicators with colon (": Season 2", ": The Final Season")
    .replace(/:\s*(?:Season|Part|Cour)\s*\d+/gi, '')
    .replace(/:\s*The\s+Final\s+Season/gi, '')
    .replace(/:\s*Final\s+Season/gi, '')
    // Remove season indicators without colon
    .replace(/\s+(?:Season|Part|Cour)\s*\d+/gi, '')
    .replace(/\s+The\s+Final\s+Season/gi, '')
    .replace(/\s+Final\s+Season/gi, '')
    // Remove ordinal seasons (2nd Season, 3rd Season)
    .replace(/\s*\d+(?:st|nd|rd|th)\s*Season/gi, '')
    // Remove year-based seasons (2024, etc.) but only at very end
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    // Remove Roman numerals at end (II, III, IV)
    .replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)$/gi, '')
    // Clean up trailing colons and whitespace
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group anime by IMDB ID - this naturally groups all seasons together
 * Since all seasons of a show share the same IMDB ID, we just keep the best entry
 */
function groupByImdbId(animeList) {
  console.log('🔗 Grouping by IMDB ID (seasons share same IMDB)...');
  
  // Group by IMDB ID
  const groups = new Map();
  
  for (const anime of animeList) {
    const imdbId = anime.imdb_id;
    
    if (!groups.has(imdbId)) {
      groups.set(imdbId, []);
    }
    groups.get(imdbId).push(anime);
  }
  
  // For each group, pick the best entry (highest popularity, prefer earlier year)
  const result = [];
  let mergedCount = 0;
  
  for (const [imdbId, entries] of groups) {
    if (entries.length === 1) {
      // Single entry - clean up the title
      const entry = entries[0];
      entry.name = extractBaseTitle(entry.name) || entry.name;
      result.push(entry);
    } else {
      // Multiple entries with same IMDB - merge them
      mergedCount += entries.length - 1;
      
      // Sort by: earliest year first, then highest popularity
      entries.sort((a, b) => {
        // Prefer earliest year (original season)
        if (a.year && b.year && a.year !== b.year) {
          return a.year - b.year;
        }
        // Then by popularity
        return (b.popularity || 0) - (a.popularity || 0);
      });
      
      const primary = entries[0];
      
      // Use clean base title
      primary.name = extractBaseTitle(primary.name) || primary.name;
      
      // Merge genres from all entries
      const allGenres = new Set(primary.genres || []);
      for (const entry of entries) {
        if (entry.genres) {
          entry.genres.forEach(g => allGenres.add(g));
        }
      }
      primary.genres = [...allGenres];
      
      // Take highest rating
      const ratings = entries.map(e => e.rating).filter(r => r != null);
      if (ratings.length > 0) {
        primary.rating = Math.max(...ratings);
      }
      
      // Sum up popularity
      primary.popularity = entries.reduce((sum, e) => sum + (e.popularity || 0), 0);
      
      // Track merged count
      primary._mergedSeasons = entries.length;
      
      result.push(primary);
    }
  }
  
  console.log(`   ✅ Grouped ${animeList.length} → ${result.length} entries (merged ${mergedCount} duplicates)\n`);
  return result;
}

// ============================================================
// CONVERT KITSU TO STREMIO FORMAT
// ============================================================

function convertToStremioMeta(kitsuAnime, imdbId, malId) {
  const attrs = kitsuAnime.attributes;
  
  // Get titles
  const titles = attrs.titles || {};
  const name = titles.en || titles.en_jp || attrs.canonicalTitle || 'Unknown';
  
  // Get poster
  const poster = attrs.posterImage?.large || attrs.posterImage?.medium || attrs.posterImage?.original || null;
  
  // Get background
  const background = attrs.coverImage?.large || attrs.coverImage?.original || null;
  
  // Get rating (convert from 0-100 to 0-10 scale)
  const rating = attrs.averageRating ? parseFloat(attrs.averageRating) / 10 : null;
  
  // Get year from startDate
  const year = attrs.startDate ? parseInt(attrs.startDate.split('-')[0], 10) : null;
  
  // Determine season from startDate (month-based)
  let season = null;
  if (attrs.startDate) {
    const month = parseInt(attrs.startDate.split('-')[1], 10);
    if (month >= 1 && month <= 3) season = 'winter';
    else if (month >= 4 && month <= 6) season = 'spring';
    else if (month >= 7 && month <= 9) season = 'summer';
    else if (month >= 10 && month <= 12) season = 'fall';
  }
  
  // Determine status - must match handler expectations (ONGOING, FINISHED, etc.)
  let status = attrs.status;
  if (status === 'finished') status = 'FINISHED';
  else if (status === 'current') status = 'ONGOING';
  else if (status === 'upcoming') status = 'UPCOMING';
  
  return {
    id: imdbId, // Use IMDB ID as primary
    imdb_id: imdbId,
    kitsu_id: parseInt(kitsuAnime.id, 10),
    mal_id: malId,
    type: 'series',
    name: name,
    slug: attrs.slug,
    description: attrs.synopsis || attrs.description || '',
    year: year,
    season: season, // spring, summer, fall, winter
    status: status,
    rating: rating,
    poster: poster,
    background: background,
    genres: kitsuAnime._genres || [],
    episodeCount: attrs.episodeCount || null,
    runtime: attrs.episodeLength ? `${attrs.episodeLength} min` : null,
    ageRating: attrs.ageRating,
    subtype: attrs.subtype, // TV, movie, OVA, etc.
    popularity: attrs.userCount || 0,
  };
}

// ============================================================
// MAIN BUILD FUNCTION
// ============================================================

async function buildDatabase() {
  const startTime = Date.now();
  
  console.log('\n============================================================');
  console.log('       AnimeStream Database Builder v2');
  console.log('============================================================');
  console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'FULL'}`);
  console.log(`Output: ${CONFIG.outputDir}\n`);
  
  // Step 1: Load Fribb mappings (MAL -> IMDB)
  const { malToImdb, malToTmdb, kitsuToImdb } = await loadFribbMappings();
  
  // Step 2: Fetch all anime from Kitsu (with genres)
  const kitsuAnime = await fetchAllKitsuAnime();
  
  // Step 3: Fetch mappings for each anime and convert
  console.log('🔄 Processing anime and fetching mappings...\n');
  
  const processedAnime = [];
  let withImdb = 0;
  let withoutImdb = 0;
  
  // Process in batches
  const batchSize = 10;
  for (let i = 0; i < kitsuAnime.length; i += batchSize) {
    const batch = kitsuAnime.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (anime) => {
      const kitsuId = parseInt(anime.id, 10);
      
      // Try to get IMDB from Kitsu->IMDB map first
      let imdbId = kitsuToImdb.get(kitsuId);
      let malId = null;
      
      // If no direct mapping, fetch Kitsu mappings to get MAL ID
      if (!imdbId) {
        const mappings = await fetchKitsuMappings(kitsuId);
        malId = mappings.mal_id;
        
        // Try MAL->IMDB mapping
        if (malId && malToImdb.has(malId)) {
          imdbId = malToImdb.get(malId);
        }
      }
      
      // Only include if we have IMDB ID
      if (imdbId) {
        const meta = convertToStremioMeta(anime, imdbId, malId);
        processedAnime.push(meta);
        withImdb++;
      } else {
        withoutImdb++;
      }
    }));
    
    // Progress
    const processed = Math.min(i + batchSize, kitsuAnime.length);
    process.stdout.write(`\r   ${progressBar(processed, kitsuAnime.length)} - ${withImdb} with IMDB`);
    
    await sleep(CONFIG.requestDelay);
  }
  
  console.log(`\n\n   📊 Results: ${withImdb} with IMDB, ${withoutImdb} without (filtered out)\n`);
  
  // Step 4: Group by IMDB ID (naturally groups seasons)
  const groupedAnime = groupByImdbId(processedAnime);
  
  // Step 5: Sort by popularity
  groupedAnime.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  
  // Step 6: Build filter options
  console.log('📋 Building filter options...');
  const genreCounts = new Map();
  const yearCounts = new Map();
  const statusCounts = new Map();
  const seasonCounts = new Map(); // "2026 - Winter" format
  const weekdayCounts = new Map(); // For Currently Airing
  
  for (const anime of groupedAnime) {
    // Genres
    if (anime.genres && anime.genres.length > 0) {
      for (const genre of anime.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }
    // Years
    if (anime.year) {
      yearCounts.set(anime.year, (yearCounts.get(anime.year) || 0) + 1);
    }
    // Status
    if (anime.status) {
      statusCounts.set(anime.status, (statusCounts.get(anime.status) || 0) + 1);
    }
    // Seasons (for Season Releases catalog)
    if (anime.year && anime.season) {
      const seasonName = anime.season.charAt(0).toUpperCase() + anime.season.slice(1).toLowerCase();
      const seasonKey = `${anime.year} - ${seasonName}`;
      seasonCounts.set(seasonKey, (seasonCounts.get(seasonKey) || 0) + 1);
    }
    // Weekdays for ONGOING anime
    if (anime.status === 'ONGOING' && anime.broadcastDay) {
      const day = anime.broadcastDay.charAt(0).toUpperCase() + anime.broadcastDay.slice(1).toLowerCase();
      weekdayCounts.set(day, (weekdayCounts.get(day) || 0) + 1);
    }
  }
  
  // Build filter options with proper format expected by manifest
  const filterOptions = {
    genres: {
      withCounts: [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} (${count})`),
      list: [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }))
    },
    seasons: {
      withCounts: [...seasonCounts.entries()]
        .sort((a, b) => {
          // Sort by year desc, then by season order
          const [aYear, aSeason] = a[0].split(' - ');
          const [bYear, bSeason] = b[0].split(' - ');
          if (aYear !== bYear) return parseInt(bYear) - parseInt(aYear);
          const seasonOrder = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };
          return seasonOrder[bSeason] - seasonOrder[aSeason];
        })
        .map(([name, count]) => `${name} (${count})`),
      list: [...seasonCounts.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([name, count]) => ({ name, count }))
    },
    weekdays: {
      withCounts: [...weekdayCounts.entries()]
        .sort((a, b) => {
          const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
          return dayOrder.indexOf(a[0]) - dayOrder.indexOf(b[0]);
        })
        .map(([name, count]) => `${name} (${count})`),
      list: [...weekdayCounts.entries()]
        .map(([name, count]) => ({ name, count }))
    },
    years: [...yearCounts.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, count]) => ({ name: year.toString(), count })),
    statuses: [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))
  };
  
  console.log(`   ✅ ${filterOptions.genres.list.length} genres, ${filterOptions.seasons.list.length} seasons, ${filterOptions.years.length} years\n`);
  
  // Step 7: Write output files
  console.log('💾 Writing output files...');
  
  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  // Build catalog object (must match databaseLoader expected format)
  const catalog = {
    buildDate: new Date().toISOString(),
    version: '2.0',
    source: 'kitsu+fribb',
    stats: {
      totalAnime: groupedAnime.length
    },
    catalog: groupedAnime
  };
  
  // Write JSON
  const jsonPath = path.join(CONFIG.outputDir, CONFIG.catalogFile);
  const jsonContent = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(jsonPath, jsonContent);
  console.log(`   📄 ${CONFIG.catalogFile}: ${formatSize(jsonContent.length)}`);
  
  // Write compressed JSON
  const gzPath = path.join(CONFIG.outputDir, CONFIG.catalogGzFile);
  const compressed = zlib.gzipSync(jsonContent);
  fs.writeFileSync(gzPath, compressed);
  const compressionRatio = Math.round((1 - compressed.length / jsonContent.length) * 100);
  console.log(`   📦 ${CONFIG.catalogGzFile}: ${formatSize(compressed.length)} (${compressionRatio}% compression)`);
  
  // Write filter options
  const filterPath = path.join(CONFIG.outputDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   📋 ${CONFIG.filterOptionsFile}: ${formatSize(fs.statSync(filterPath).size)}`);
  
  // Summary
  const duration = Date.now() - startTime;
  console.log('\n============================================================');
  console.log(`✅ Database build complete in ${formatDuration(duration)}`);
  console.log('============================================================');
  console.log(`   Total anime: ${groupedAnime.length}`);
  console.log(`   All entries have IMDB IDs (streams will work!)`);
  console.log(`   Seasons grouped by shared IMDB ID`);
  console.log('============================================================\n');
}

// Run
buildDatabase().catch(err => {
  console.error('\n❌ Build failed:', err.message);
  process.exit(1);
});
