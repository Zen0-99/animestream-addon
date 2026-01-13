#!/usr/bin/env node
/**
 * TMDB-based Database Builder
 * 
 * Uses TMDB (The Movie Database) as the primary source for anime.
 * Benefits over MAL/anime-offline-database:
 * - Proper season grouping (all seasons under one show)
 * - IMDB IDs for stream addon compatibility
 * - Clean, consistent metadata
 * 
 * Usage: 
 *   node scripts/build-database-tmdb.js
 *   node scripts/build-database-tmdb.js --test (first 100 only)
 * 
 * Requires: TMDB_API_KEY environment variable
 *   Get one free at: https://www.themoviedb.org/settings/api
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const TEST_MODE = process.argv.includes('--test');
const TEST_LIMIT = 100;

const CONFIG = {
  outputDir: path.join(__dirname, '..', 'data'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  catalogGzFile: TEST_MODE ? 'catalog-test.json.gz' : 'catalog.json.gz',
  filterOptionsFile: 'filter-options.json',
  
  // TMDB API settings
  tmdbBaseUrl: 'https://api.themoviedb.org/3',
  tmdbImageBase: 'https://image.tmdb.org/t/p/',
  
  // Animation genre ID in TMDB
  animationGenreId: 16,
  
  // Japanese origin country
  japanCountryCode: 'JP'
};

// TMDB Genre ID to name mapping (for anime-relevant genres)
const TMDB_GENRES = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics'
};

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Progress bar helper
 */
function progressBar(current, total, width = 30) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  return `[${bar}] ${percent}% (${current}/${total})`;
}

/**
 * Make TMDB API request with rate limiting and retries
 */
let lastRequestTime = 0;
let consecutiveErrors = 0;

async function tmdbRequest(endpoint, params = {}, retries = 3) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    throw new Error('TMDB_API_KEY environment variable is required. Get one at https://www.themoviedb.org/settings/api');
  }
  
  const url = new URL(`${CONFIG.tmdbBaseUrl}${endpoint}`);
  url.searchParams.set('api_key', apiKey);
  
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }
  
  const fetch = (await import('node-fetch')).default;
  
  // Rate limit: TMDB allows ~40 requests per 10 seconds, be conservative
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  const minDelay = consecutiveErrors > 0 ? 500 : 300; // Slower if we've had errors
  
  if (timeSinceLastRequest < minDelay) {
    await sleep(minDelay - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
  
  try {
    const response = await fetch(url.toString(), { timeout: 30000 });
    
    if (response.status === 429) {
      // Rate limited - wait and retry
      console.log('\n   [RATE LIMITED] Waiting 15s...');
      await sleep(15000);
      consecutiveErrors++;
      return tmdbRequest(endpoint, params, retries);
    }
    
    if (!response.ok) {
      if (retries > 0 && response.status >= 500) {
        console.log(`\n   [ERR ${response.status}] Retrying in 5s...`);
        await sleep(5000);
        return tmdbRequest(endpoint, params, retries - 1);
      }
      throw new Error(`TMDB API error: ${response.status} ${response.statusText}`);
    }
    
    consecutiveErrors = 0; // Reset on success
    return response.json();
  } catch (err) {
    if (retries > 0 && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.type === 'request-timeout')) {
      console.log(`\n   [TIMEOUT] Retrying in 3s...`);
      await sleep(3000);
      consecutiveErrors++;
      return tmdbRequest(endpoint, params, retries - 1);
    }
    throw err;
  }
}

/**
 * Fetch all Japanese animated TV shows from TMDB
 */
async function fetchAnimeList(maxPages = 500) {
  console.log('\n[TMDB] Fetching Japanese animated TV shows...');
  
  const allShows = [];
  let page = 1;
  let totalPages = 1;
  
  while (page <= totalPages && page <= maxPages) {
    try {
      const data = await tmdbRequest('/discover/tv', {
        with_genres: CONFIG.animationGenreId,
        with_origin_country: CONFIG.japanCountryCode,
        sort_by: 'popularity.desc',
        page: page
      });
      
      totalPages = Math.min(data.total_pages, maxPages);
      
      for (const show of data.results) {
        allShows.push(show);
      }
      
      process.stdout.write(`\r   Page ${page}/${totalPages} (${allShows.length} shows)`);
      
      if (TEST_MODE && allShows.length >= TEST_LIMIT) {
        console.log(`\n   TEST MODE: Stopping at ${TEST_LIMIT} shows`);
        break;
      }
      
      page++;
    } catch (err) {
      console.log(`\n   [ERR] Page ${page}: ${err.message}`);
      break;
    }
  }
  
  console.log(`\n   [TMDB] Total shows: ${allShows.length}`);
  return TEST_MODE ? allShows.slice(0, TEST_LIMIT) : allShows;
}

/**
 * Get detailed info for a TV show including external IDs
 * Sequential requests to avoid rate limiting
 */
async function getShowDetails(tmdbId) {
  try {
    // Sequential instead of parallel to avoid rate limits
    const details = await tmdbRequest(`/tv/${tmdbId}`);
    const externalIds = await tmdbRequest(`/tv/${tmdbId}/external_ids`);
    
    return { ...details, external_ids: externalIds };
  } catch (err) {
    // Don't log individual errors to avoid spam
    return null;
  }
}

/**
 * Convert TMDB show to Stremio meta format
 */
function convertToStremioMeta(show, details) {
  const imdbId = details?.external_ids?.imdb_id || null;
  
  // Skip shows without IMDB ID (streams won't work)
  if (!imdbId) return null;
  
  // Extract genres
  const genres = (details?.genres || show.genre_ids?.map(id => ({ id, name: TMDB_GENRES[id] })) || [])
    .map(g => g.name)
    .filter(Boolean);
  
  // Get rating
  const rating = show.vote_average || details?.vote_average || null;
  
  // Check if future release (no air date yet or in future)
  let displayRating = rating;
  if (show.first_air_date) {
    const airDate = new Date(show.first_air_date);
    const now = new Date();
    if (airDate > now) {
      displayRating = null; // Future release
    }
  } else {
    displayRating = null; // No air date = upcoming
  }
  
  // Build poster URL
  const posterPath = show.poster_path || details?.poster_path;
  const backdropPath = show.backdrop_path || details?.backdrop_path;
  
  const meta = {
    id: imdbId, // Use IMDB ID as primary identifier for stream compatibility
    type: 'series',
    name: show.name,
    
    // IDs for cross-referencing
    tmdbId: show.id,
    imdb_id: imdbId,
    
    // Images
    poster: posterPath ? `${CONFIG.tmdbImageBase}w500${posterPath}` : null,
    background: backdropPath ? `${CONFIG.tmdbImageBase}original${backdropPath}` : null,
    
    // Metadata
    genres: genres.length > 0 ? genres : undefined,
    rating: displayRating,
    
    // Release info
    year: show.first_air_date ? parseInt(show.first_air_date.substring(0, 4)) : null,
    releaseInfo: show.first_air_date ? show.first_air_date.substring(0, 4) : null,
    
    // Status
    status: details?.status === 'Returning Series' ? 'ONGOING' :
            details?.status === 'Ended' ? 'FINISHED' :
            details?.status === 'In Production' ? 'UPCOMING' : null,
    
    // Season count
    seasons: details?.number_of_seasons || null,
    episodes: details?.number_of_episodes || null,
    
    // Networks/studios
    studios: (details?.networks || []).map(n => n.name),
    
    // Description (for search)
    description: show.overview || details?.overview || null
  };
  
  // Only include non-null values
  return Object.fromEntries(
    Object.entries(meta).filter(([_, v]) => v !== null && v !== undefined)
  );
}

/**
 * Main build function
 */
async function buildDatabase() {
  const startTime = Date.now();
  
  console.log('============================================================');
  console.log('       AnimeStream TMDB Database Builder');
  console.log('============================================================');
  console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'FULL'}`);
  console.log(`Output: ${CONFIG.outputDir}`);
  console.log('');
  
  // Check for API key
  if (!process.env.TMDB_API_KEY) {
    console.error('[ERR] TMDB_API_KEY environment variable is required!');
    console.error('      Get a free API key at: https://www.themoviedb.org/settings/api');
    console.error('      Then run: $env:TMDB_API_KEY="your_key"; node scripts/build-database-tmdb.js');
    process.exit(1);
  }
  
  // Fetch anime list
  const shows = await fetchAnimeList();
  
  // Get detailed info for each show
  console.log('\n[DETAILS] Fetching show details and IMDB IDs...');
  
  const catalog = [];
  const genreCounts = new Map();
  const studioCounts = new Map();
  let withImdb = 0;
  let skippedNoImdb = 0;
  
  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    
    const details = await getShowDetails(show.id);
    const meta = convertToStremioMeta(show, details);
    
    if (meta) {
      catalog.push(meta);
      withImdb++;
      
      // Count genres
      if (meta.genres) {
        for (const genre of meta.genres) {
          genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
        }
      }
      
      // Count studios
      if (meta.studios) {
        for (const studio of meta.studios) {
          studioCounts.set(studio, (studioCounts.get(studio) || 0) + 1);
        }
      }
    } else {
      skippedNoImdb++;
    }
    
    // Progress
    if ((i + 1) % 50 === 0 || i === shows.length - 1) {
      process.stdout.write(`\r   ${progressBar(i + 1, shows.length)} - ${catalog.length} with IMDB`);
    }
  }
  
  console.log('\n');
  
  // Sort by rating (highest first)
  catalog.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  
  console.log('[STATS] Results:');
  console.log(`   Total processed: ${shows.length}`);
  console.log(`   With IMDB ID: ${withImdb} (${((withImdb / shows.length) * 100).toFixed(1)}%)`);
  console.log(`   Skipped (no IMDB): ${skippedNoImdb}`);
  console.log(`   Unique genres: ${genreCounts.size}`);
  console.log(`   Unique studios: ${studioCounts.size}`);
  
  // Build filter options
  console.log('\n[FILTERS] Building filter options...');
  
  const genreOptions = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([genre, count]) => `${genre} (${count})`);
  
  const studioOptions = Array.from(studioCounts.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([studio, count]) => `${studio} (${count})`);
  
  const filterOptions = {
    genres: {
      withCounts: genreOptions,
      values: Array.from(genreCounts.keys()).sort()
    },
    studios: {
      withCounts: studioOptions,
      values: Array.from(studioCounts.keys()).sort()
    }
  };
  
  // Build database object
  const database = {
    version: 2,
    source: 'TMDB',
    buildDate: new Date().toISOString(),
    stats: {
      totalAnime: catalog.length,
      withImdb,
      genres: genreCounts.size,
      studios: studioCounts.size
    },
    catalog
  };
  
  // Write files
  console.log('\n[WRITE] Writing output files...');
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  // Write uncompressed JSON
  const jsonPath = path.join(CONFIG.outputDir, CONFIG.catalogFile);
  fs.writeFileSync(jsonPath, JSON.stringify(database, null, 2));
  const jsonSize = fs.statSync(jsonPath).size;
  console.log(`   ${CONFIG.catalogFile}: ${(jsonSize / 1024 / 1024).toFixed(2)} MB`);
  
  // Write compressed gzip
  const gzPath = path.join(CONFIG.outputDir, CONFIG.catalogGzFile);
  const compressed = zlib.gzipSync(JSON.stringify(database));
  fs.writeFileSync(gzPath, compressed);
  const gzSize = compressed.length;
  console.log(`   ${CONFIG.catalogGzFile}: ${(gzSize / 1024 / 1024).toFixed(2)} MB (${((1 - gzSize/jsonSize) * 100).toFixed(0)}% compression)`);
  
  // Write filter options
  const filterPath = path.join(CONFIG.outputDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   ${CONFIG.filterOptionsFile}: ${(fs.statSync(filterPath).size / 1024).toFixed(1)} KB`);
  
  // Done
  const duration = Date.now() - startTime;
  console.log('\n============================================================');
  console.log(`[DONE] TMDB database build complete in ${formatDuration(duration)}`);
  console.log('============================================================');
  console.log('\nNOTE: This database uses IMDB IDs as primary identifiers.');
  console.log('      Streams from Torrentio/Comet will work automatically!');
}

// Run
buildDatabase().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
