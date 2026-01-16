#!/usr/bin/env node

/**
 * Incremental Update Script - Comprehensive Catalog Maintenance
 * 
 * This script combines functionality from:
 * - detect-non-anime.js (filter out Western animation)
 * - enrich-metadata.js (fill missing metadata from external sources)
 * - find-broken-posters.js (detect broken poster URLs)
 * - update-database.js (fetch new anime from Jikan)
 * - fix-airing-status.js (validate airing status)
 * 
 * Features:
 * 1. Fetch new anime from Jikan API (currently airing + new releases)
 * 2. Detect and filter non-anime entries
 * 3. Check for broken/missing metadata
 * 4. Enrich metadata from Cinemeta, Kitsu, and MAL
 * 5. Quality control for "Currently Airing" catalog
 * 6. Update dynamic filter counts (e.g., "Monday (8)")
 * 7. Categorize anime into appropriate catalogs
 * 
 * Usage:
 *   node scripts/incremental-update.js                    # Full update
 *   node scripts/incremental-update.js --dry-run          # Preview changes
 *   node scripts/incremental-update.js --quality-control  # Only run QC
 *   node scripts/incremental-update.js --new-anime        # Only fetch new anime
 *   node scripts/incremental-update.js --enrich           # Only enrich metadata
 *   node scripts/incremental-update.js --verbose          # Detailed output
 * 
 * @author AnimeStream
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ========== CONFIGURATION ==========

const CONFIG = {
  dataDir: path.join(__dirname, '..', 'data'),
  workerFile: path.join(__dirname, '..', 'cloudflare-worker', 'worker-github.js'),
  
  files: {
    catalog: 'catalog.json',
    catalogGz: 'catalog.json.gz',
    filterOptions: 'filter-options.json',
  },
  
  api: {
    jikan: {
      baseUrl: 'https://api.jikan.moe/v4',
      rateLimit: 400, // ms between requests
      maxRetries: 3,
    },
    kitsu: {
      baseUrl: 'https://kitsu.io/api/edge',
      rateLimit: 200,
    },
    cinemeta: {
      baseUrl: 'https://v3-cinemeta.strem.io',
    }
  },
  
  thresholds: {
    minDescriptionLength: 50,
    minMatchScore: 60,
    airingGracePeriodDays: 14, // Days after last episode before marking as finished
  }
};

// ========== SEASON DETECTION ==========

function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  
  let season;
  if (month >= 1 && month <= 3) {
    season = 'Winter';
  } else if (month >= 4 && month <= 6) {
    season = 'Spring';
  } else if (month >= 7 && month <= 9) {
    season = 'Summer';
  } else {
    season = 'Fall';
  }
  
  return { year, season, display: `${year} - ${season}` };
}

function getNextSeason(currentSeason) {
  const seasonOrder = ['Winter', 'Spring', 'Summer', 'Fall'];
  const currentIdx = seasonOrder.indexOf(currentSeason.season);
  
  if (currentIdx === 3) {
    // Fall -> Winter of next year
    return { year: currentSeason.year + 1, season: 'Winter', display: `${currentSeason.year + 1} - Winter` };
  } else {
    const nextSeason = seasonOrder[currentIdx + 1];
    return { year: currentSeason.year, season: nextSeason, display: `${currentSeason.year} - ${nextSeason}` };
  }
}

function isFutureSeason(seasonYear, seasonName, currentSeason) {
  const seasonOrder = { 'winter': 0, 'spring': 1, 'summer': 2, 'fall': 3 };
  
  if (seasonYear > currentSeason.year) return true;
  if (seasonYear < currentSeason.year) return false;
  
  const currentOrder = seasonOrder[currentSeason.season.toLowerCase()];
  const checkOrder = seasonOrder[seasonName.toLowerCase()];
  
  return checkOrder > currentOrder;
}

// ========== CLI ARGUMENTS ==========

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const QUALITY_CONTROL_ONLY = args.includes('--quality-control');
const NEW_ANIME_ONLY = args.includes('--new-anime');
const ENRICH_ONLY = args.includes('--enrich');
const APPLY_CHANGES = args.includes('--apply');

// ========== NON-ANIME DETECTION ==========

const WESTERN_STUDIOS = new Set([
  'cartoon network', 'nickelodeon', 'disney', 'pixar', 'dreamworks',
  'warner bros', 'warner animation', 'netflix animation', 'amazon studios',
  'hbo max', 'adult swim', 'frederator', 'sony pictures animation',
  'illumination', 'blue sky', 'laika', 'aardman', 'paramount animation',
  'riot games', 'rooster teeth', 'powerhouse animation', 'titmouse',
  'studio mir',
]);

const WESTERN_KEYWORDS = [
  'cartoon network', 'nickelodeon', 'disney+', 'disney plus',
  'netflix original', 'amazon original', 'hbo max', 'adult swim',
  'american animated', 'western animated', 'cgi animated film',
  'league of legends', 'riot games', 'dota', 'based on the video game',
];

const KNOWN_NON_ANIME = new Set([
  'tt12895414', // The SpongeBob SquarePants Anime
  'tt11126994', // Arcane
  'tt15248880', // Adventure Time: Fionna & Cake
  'tt0772166',  // The Boondocks
  'tt4633694',  // Spider-Man: Into the Spider-Verse
  'tt9362722',  // Spider-Man: Across the Spider-Verse
  'tt16360004', // Spider-Man: Beyond the Spider-Verse
  'tt0417299',  // Avatar: The Last Airbender
  'tt1695360',  // The Legend of Korra
  'tt9432978',  // DOTA: Dragon's Blood
  'tt6644294',  // Castlevania
  'tt3398228',  // Trollhunters
  'tt7538988',  // Voltron: Legendary Defender
  'tt8050756',  // She-Ra / The Owl House
  'tt9561862',  // Blood of Zeus
  'tt29661543', // #holoEN3DRepeat
]);

// ========== UTILITY FUNCTIONS ==========

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  const prefix = {
    'info': '  ',
    'success': '✓ ',
    'warning': '⚠ ',
    'error': '✗ ',
    'debug': '  [DEBUG] '
  }[level] || '  ';
  
  if (level === 'debug' && !VERBOSE) return;
  console.log(`${prefix}${message}`);
}

async function fetchWithRetry(url, options = {}, retries = CONFIG.api.jikan.maxRetries) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { ...options, timeout: 15000 });
      
      if (response.status === 429) {
        log(`Rate limited, waiting 5s...`, 'warning');
        await sleep(5000);
        continue;
      }
      
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return response;
    } catch (err) {
      if (i < retries - 1) {
        log(`Retry ${i + 1}/${retries}: ${err.message}`, 'debug');
        await sleep(1000 * (i + 1));
      } else {
        throw err;
      }
    }
  }
}

// ========== DATA LOADING ==========

function loadCatalog() {
  const catalogPath = path.join(CONFIG.dataDir, CONFIG.files.catalog);
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog not found: ${catalogPath}`);
  }
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
}

function saveCatalog(data) {
  if (DRY_RUN) {
    log('DRY RUN - Would save catalog with changes', 'info');
    return;
  }
  
  const catalogPath = path.join(CONFIG.dataDir, CONFIG.files.catalog);
  const catalogGzPath = path.join(CONFIG.dataDir, CONFIG.files.catalogGz);
  
  // Update build date
  data.buildDate = new Date().toISOString();
  
  fs.writeFileSync(catalogPath, JSON.stringify(data, null, 2));
  
  // Also write gzipped version
  const jsonStr = JSON.stringify(data);
  const gzipped = zlib.gzipSync(jsonStr);
  fs.writeFileSync(catalogGzPath, gzipped);
  
  log(`Saved catalog: ${data.catalog.length} anime`, 'success');
}

function loadFilterOptions() {
  const filterPath = path.join(CONFIG.dataDir, CONFIG.files.filterOptions);
  if (!fs.existsSync(filterPath)) {
    return { genres: {}, seasons: {}, weekdays: {}, movieGenres: {} };
  }
  return JSON.parse(fs.readFileSync(filterPath, 'utf8'));
}

function saveFilterOptions(data) {
  if (DRY_RUN) {
    log('DRY RUN - Would save filter options', 'info');
    return;
  }
  
  const filterPath = path.join(CONFIG.dataDir, CONFIG.files.filterOptions);
  fs.writeFileSync(filterPath, JSON.stringify(data, null, 2));
  log('Saved filter options', 'success');
}

// ========== NON-ANIME DETECTION ==========

function checkWesternStudio(anime) {
  const studios = (anime.studios || []).map(s => s.toLowerCase());
  for (const studio of studios) {
    for (const western of WESTERN_STUDIOS) {
      if (studio.includes(western)) {
        return { isWestern: true, studio };
      }
    }
  }
  return { isWestern: false };
}

function checkWesternKeywords(anime) {
  const text = [anime.name || '', anime.description || ''].join(' ').toLowerCase();
  
  for (const keyword of WESTERN_KEYWORDS) {
    if (text.includes(keyword)) {
      return { hasWesternKeyword: true, keyword };
    }
  }
  return { hasWesternKeyword: false };
}

async function checkMALExists(animeName) {
  try {
    await sleep(CONFIG.api.jikan.rateLimit);
    const searchName = animeName.replace(/\s*\(TV\)$/i, '').replace(/\s*Season\s*\d+$/i, '').trim();
    const response = await fetchWithRetry(
      `${CONFIG.api.jikan.baseUrl}/anime?q=${encodeURIComponent(searchName)}&limit=3`
    );
    
    if (!response.ok) return { found: false, reason: 'API error' };
    
    const data = await response.json();
    if (!data.data || data.data.length === 0) {
      return { found: false, reason: 'Not found on MAL' };
    }
    
    // Check for close match
    const normalizedSearch = searchName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    for (const anime of data.data) {
      const titles = [
        anime.title, anime.title_english, anime.title_japanese,
        ...(anime.title_synonyms || [])
      ].filter(Boolean);
      
      for (const title of titles) {
        const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedTitle === normalizedSearch || 
            normalizedTitle.includes(normalizedSearch) ||
            normalizedSearch.includes(normalizedTitle)) {
          
          // Check for "Anime Influenced" tag
          const genres = anime.genres?.map(g => g.name.toLowerCase()) || [];
          const themes = anime.themes?.map(t => t.name.toLowerCase()) || [];
          
          if ([...genres, ...themes].includes('anime influenced')) {
            return { found: true, isAnimeInfluenced: true, malId: anime.mal_id };
          }
          
          return { found: true, isAnimeInfluenced: false, malId: anime.mal_id };
        }
      }
    }
    
    return { found: false, reason: 'No close title match' };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

async function detectNonAnime(anime) {
  const result = {
    id: anime.id || anime.imdb_id,
    name: anime.name,
    isNonAnime: false,
    confidence: 0,
    reasons: []
  };
  
  // Check known blacklist
  if (KNOWN_NON_ANIME.has(result.id)) {
    result.isNonAnime = true;
    result.confidence = 100;
    result.reasons.push('In known non-anime blacklist');
    return result;
  }
  
  // Check Western studio
  const studioCheck = checkWesternStudio(anime);
  if (studioCheck.isWestern) {
    result.confidence += 40;
    result.reasons.push(`Western studio: ${studioCheck.studio}`);
  }
  
  // Check Western keywords
  const keywordCheck = checkWesternKeywords(anime);
  if (keywordCheck.hasWesternKeyword) {
    result.confidence += 30;
    result.reasons.push(`Western keyword: "${keywordCheck.keyword}"`);
  }
  
  // MAL verification for suspicious entries
  if (result.confidence >= 20) {
    const malCheck = await checkMALExists(anime.name);
    if (!malCheck.found) {
      result.confidence += 30;
      result.reasons.push(`MAL: ${malCheck.reason}`);
    } else if (malCheck.isAnimeInfluenced) {
      result.confidence += 50;
      result.reasons.push('Tagged as "Anime Influenced" on MAL');
    }
  }
  
  result.isNonAnime = result.confidence >= 50;
  return result;
}

// ========== METADATA ANALYSIS ==========

function analyzeMetadata(anime) {
  const issues = [];
  const missing = {};
  
  if (!anime.poster) {
    issues.push('missing_poster');
    missing.poster = true;
  }
  
  if (!anime.description || anime.description.length < CONFIG.thresholds.minDescriptionLength) {
    issues.push(anime.description ? 'short_description' : 'missing_description');
    missing.description = true;
  }
  
  if (!anime.runtime) {
    issues.push('missing_runtime');
    missing.runtime = true;
  }
  
  if (!anime.rating && anime.rating !== 0) {
    issues.push('missing_rating');
    missing.rating = true;
  }
  
  if (!anime.background) {
    issues.push('missing_background');
    missing.background = true;
  }
  
  if (!anime.genres || anime.genres.length === 0) {
    issues.push('missing_genres');
    missing.genres = true;
  }
  
  if (!anime.cast || anime.cast.length === 0) {
    issues.push('missing_cast');
    missing.cast = true;
  }
  
  return { issues, missing };
}

async function checkPosterUrl(url) {
  if (!url) return { status: 'missing' };
  
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return {
      status: response.ok ? 'ok' : 'broken',
      code: response.status
    };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

// ========== METADATA ENRICHMENT ==========

async function fetchCinemeta(imdbId) {
  try {
    const response = await fetchWithRetry(`${CONFIG.api.cinemeta.baseUrl}/meta/series/${imdbId}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.meta || null;
  } catch (e) {
    log(`Cinemeta error: ${e.message}`, 'debug');
    return null;
  }
}

async function fetchKitsu(animeName) {
  try {
    await sleep(CONFIG.api.kitsu.rateLimit);
    const searchName = animeName.replace(/\s*\(TV\)$/i, '').replace(/\s*Season\s*\d+$/i, '').trim();
    const response = await fetchWithRetry(
      `${CONFIG.api.kitsu.baseUrl}/anime?filter[text]=${encodeURIComponent(searchName)}&include=genres`
    );
    if (!response.ok) return null;
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      const attrs = data.data[0].attributes;
      let genres = [];
      if (data.included) {
        genres = data.included
          .filter(inc => inc.type === 'genres')
          .map(inc => inc.attributes.name)
          .filter(Boolean);
      }
      return { ...attrs, extractedGenres: genres };
    }
    return null;
  } catch (e) {
    log(`Kitsu error: ${e.message}`, 'debug');
    return null;
  }
}

async function fetchMAL(animeName) {
  try {
    await sleep(CONFIG.api.jikan.rateLimit);
    const searchName = animeName.replace(/\s*\(TV\)$/i, '').replace(/\s*Season\s*\d+$/i, '').trim();
    const response = await fetchWithRetry(
      `${CONFIG.api.jikan.baseUrl}/anime?q=${encodeURIComponent(searchName)}&limit=3`
    );
    if (!response.ok) return null;
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      const normalizedSearch = searchName.toLowerCase().replace(/[^a-z0-9]/g, '');
      let bestMatch = data.data[0];
      let bestScore = 0;
      
      for (const anime of data.data) {
        const titles = [
          anime.title, anime.title_english, anime.title_japanese,
          ...(anime.title_synonyms || [])
        ].filter(Boolean);
        
        for (const title of titles) {
          const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normalizedTitle === normalizedSearch) {
            bestMatch = anime;
            bestScore = 100;
            break;
          }
          if (normalizedTitle.includes(normalizedSearch) || normalizedSearch.includes(normalizedTitle)) {
            const score = Math.min(normalizedSearch.length, normalizedTitle.length) / 
                         Math.max(normalizedSearch.length, normalizedTitle.length) * 80;
            if (score > bestScore) {
              bestMatch = anime;
              bestScore = score;
            }
          }
        }
        if (bestScore === 100) break;
      }
      
      return {
        mal_id: bestMatch.mal_id,
        title: bestMatch.title,
        synopsis: bestMatch.synopsis,
        score: bestMatch.score,
        episodes: bestMatch.episodes,
        duration: bestMatch.duration,
        status: bestMatch.status,
        aired: bestMatch.aired,
        broadcast: bestMatch.broadcast,
        genres: bestMatch.genres?.map(g => g.name) || [],
        themes: bestMatch.themes?.map(t => t.name) || [],
        poster: bestMatch.images?.jpg?.large_image_url,
        background: bestMatch.images?.jpg?.large_image_url,
        matchScore: bestScore
      };
    }
    return null;
  } catch (e) {
    log(`MAL error: ${e.message}`, 'debug');
    return null;
  }
}

async function enrichAnime(anime, missing) {
  const enrichment = { poster: null, metadata: {} };
  
  log(`Enriching: ${anime.name}`, 'debug');
  
  // Fetch from all sources
  const [cinemeta, kitsu] = await Promise.all([
    anime.id?.startsWith('tt') ? fetchCinemeta(anime.id) : Promise.resolve(null),
    fetchKitsu(anime.name)
  ]);
  
  const mal = await fetchMAL(anime.name);
  
  // Check what Cinemeta already has
  const cinemataHas = {
    runtime: !!cinemeta?.runtime,
    genres: cinemeta?.genres?.length > 0,
    background: !!cinemeta?.background,
    description: cinemeta?.description?.length > 50,
    cast: cinemeta?.cast?.length > 0,
  };
  
  // Poster: Kitsu > MAL
  if (missing.poster) {
    if (kitsu?.posterImage?.large) {
      const check = await checkPosterUrl(kitsu.posterImage.large);
      if (check.status === 'ok') enrichment.poster = kitsu.posterImage.large;
    }
    if (!enrichment.poster && mal?.poster) {
      const check = await checkPosterUrl(mal.poster);
      if (check.status === 'ok') enrichment.poster = mal.poster;
    }
  }
  
  // Runtime (only if Cinemeta doesn't have it)
  if (missing.runtime && !cinemataHas.runtime && mal?.duration) {
    const match = mal.duration.match(/(\d+)\s*min/i);
    if (match) enrichment.metadata.runtime = `${match[1]} min`;
  }
  
  // Rating (always prefer MAL for anime)
  if (missing.rating && mal?.score) {
    enrichment.metadata.rating = mal.score;
  }
  
  // Genres (only if Cinemeta doesn't have them)
  if (missing.genres && !cinemataHas.genres) {
    if (mal?.genres?.length > 0) {
      const allGenres = [...new Set([...(mal.genres || []), ...(mal.themes || [])])];
      enrichment.metadata.genres = allGenres.slice(0, 8);
    } else if (kitsu?.extractedGenres?.length > 0) {
      enrichment.metadata.genres = kitsu.extractedGenres.slice(0, 8);
    }
  }
  
  // Background (only if Cinemeta doesn't have it)
  if (missing.background && !cinemataHas.background) {
    if (kitsu?.coverImage?.large) {
      enrichment.metadata.background = kitsu.coverImage.large;
    } else if (mal?.background) {
      enrichment.metadata.background = mal.background;
    }
  }
  
  // Description (only if Cinemeta doesn't have it)
  if (missing.description && !cinemataHas.description) {
    if (mal?.synopsis && mal.synopsis.length > 50) {
      let desc = mal.synopsis
        .replace(/\[Written by MAL Rewrite\]/g, '')
        .replace(/\(Source:.*?\)/g, '')
        .trim();
      enrichment.metadata.description = desc;
    } else if (kitsu?.synopsis && kitsu.synopsis.length > 50) {
      enrichment.metadata.description = kitsu.synopsis;
    }
  }
  
  return enrichment;
}

// ========== AIRING STATUS QUALITY CONTROL ==========

async function checkAiringStatus(anime) {
  try {
    await sleep(CONFIG.api.jikan.rateLimit);
    
    // Search by name to find current status
    const searchName = anime.name.replace(/\s*\(TV\)$/i, '').replace(/\s*Season\s*\d+$/i, '').trim();
    const response = await fetchWithRetry(
      `${CONFIG.api.jikan.baseUrl}/anime?q=${encodeURIComponent(searchName)}&limit=3`
    );
    
    if (!response.ok) return null;
    const data = await response.json();
    
    if (!data.data || data.data.length === 0) return null;
    
    // Find best match
    const normalizedSearch = searchName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    for (const result of data.data) {
      const titles = [
        result.title, result.title_english,
        ...(result.title_synonyms || [])
      ].filter(Boolean);
      
      for (const title of titles) {
        const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedTitle === normalizedSearch || 
            normalizedTitle.includes(normalizedSearch) ||
            normalizedSearch.includes(normalizedTitle)) {
          
          // Map Jikan status to our status
          const statusMap = {
            'Currently Airing': 'ONGOING',
            'Finished Airing': 'FINISHED',
            'Not yet aired': 'UPCOMING'
          };
          
          // Extract broadcast day
          let broadcastDay = null;
          if (result.broadcast?.day) {
            const dayMap = {
              'mondays': 'Monday', 'tuesdays': 'Tuesday', 'wednesdays': 'Wednesday',
              'thursdays': 'Thursday', 'fridays': 'Friday', 'saturdays': 'Saturday',
              'sundays': 'Sunday'
            };
            broadcastDay = dayMap[result.broadcast.day.toLowerCase()] || null;
          }
          
          return {
            currentStatus: statusMap[result.status] || 'UNKNOWN',
            episodeCount: result.episodes,
            broadcastDay,
            airing: result.airing,
            lastEpisode: result.aired?.to
          };
        }
      }
    }
    
    return null;
  } catch (e) {
    log(`Status check error for ${anime.name}: ${e.message}`, 'debug');
    return null;
  }
}

// ========== FILTER OPTIONS UPDATE ==========

function updateFilterOptions(catalog, currentFilterOptions) {
  const airingAnime = catalog.filter(a => a.status === 'ONGOING');
  
  // Count by weekday
  const weekdayCounts = {};
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  
  for (const day of weekdays) {
    weekdayCounts[day] = 0;
  }
  
  for (const anime of airingAnime) {
    if (anime.broadcastDay && weekdayCounts[anime.broadcastDay] !== undefined) {
      weekdayCounts[anime.broadcastDay]++;
    }
  }
  
  // Build withCounts array
  const weekdaysWithCounts = weekdays
    .filter(day => weekdayCounts[day] > 0)
    .map(day => `${day} (${weekdayCounts[day]})`);
  
  // Count genres
  const genreCounts = {};
  for (const anime of catalog) {
    for (const genre of (anime.genres || [])) {
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    }
  }
  
  const genresWithCounts = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`);
  
  // Count seasons
  const seasonCounts = {};
  for (const anime of catalog) {
    if (anime.year && anime.season) {
      const key = `${anime.season.charAt(0).toUpperCase() + anime.season.slice(1)} ${anime.year}`;
      seasonCounts[key] = (seasonCounts[key] || 0) + 1;
    }
  }
  
  const seasonsWithCounts = Object.entries(seasonCounts)
    .sort((a, b) => {
      // Sort by year descending, then by season order
      const [aSeason, aYear] = a[0].split(' ');
      const [bSeason, bYear] = b[0].split(' ');
      if (aYear !== bYear) return parseInt(bYear) - parseInt(aYear);
      const seasonOrder = { 'Winter': 0, 'Spring': 1, 'Summer': 2, 'Fall': 3 };
      return (seasonOrder[bSeason] || 0) - (seasonOrder[aSeason] || 0);
    })
    .map(([name, count]) => `${name} (${count})`);
  
  // Movie genres
  const movieGenreCounts = {};
  const movies = catalog.filter(a => a.animeType === 'MOVIE' || a.subtype === 'movie');
  for (const movie of movies) {
    for (const genre of (movie.genres || [])) {
      movieGenreCounts[genre] = (movieGenreCounts[genre] || 0) + 1;
    }
  }
  
  const movieGenresWithCounts = Object.entries(movieGenreCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`);
  
  return {
    genres: {
      withCounts: genresWithCounts,
      list: Object.entries(genreCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }))
    },
    weekdays: {
      list: weekdays.filter(day => weekdayCounts[day] > 0),
      withCounts: weekdaysWithCounts
    },
    seasons: {
      list: Object.keys(seasonCounts).sort((a, b) => {
        const [aSeason, aYear] = a.split(' ');
        const [bSeason, bYear] = b.split(' ');
        if (aYear !== bYear) return parseInt(bYear) - parseInt(aYear);
        const seasonOrder = { 'Winter': 0, 'Spring': 1, 'Summer': 2, 'Fall': 3 };
        return (seasonOrder[bSeason] || 0) - (seasonOrder[aSeason] || 0);
      }),
      withCounts: seasonsWithCounts
    },
    movieGenres: {
      list: Object.entries(movieGenreCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      withCounts: movieGenresWithCounts
    }
  };
}

// ========== NEW ANIME FETCHING ==========

async function fetchNewAnimeFromJikan() {
  log('Fetching currently airing anime from Jikan...');
  
  const allAnime = [];
  let page = 1;
  const maxPages = 10;
  
  while (page <= maxPages) {
    const url = `${CONFIG.api.jikan.baseUrl}/anime?status=airing&order_by=score&sort=desc&page=${page}`;
    
    try {
      await sleep(CONFIG.api.jikan.rateLimit);
      const response = await fetchWithRetry(url);
      
      if (!response.ok) break;
      const data = await response.json();
      
      if (!data.data || data.data.length === 0) break;
      
      allAnime.push(...data.data);
      log(`Page ${page}: ${data.data.length} anime (total: ${allAnime.length})`, 'debug');
      
      if (!data.pagination?.has_next_page) break;
      page++;
    } catch (err) {
      log(`Error fetching page ${page}: ${err.message}`, 'error');
      break;
    }
  }
  
  log(`Fetched ${allAnime.length} currently airing anime`, 'success');
  return allAnime;
}

function jikanToMeta(jikanAnime) {
  // Get season from aired dates
  let season = null;
  let year = null;
  
  if (jikanAnime.aired?.from) {
    const date = new Date(jikanAnime.aired.from);
    year = date.getFullYear();
    const month = date.getMonth();
    
    if (month >= 0 && month <= 2) season = 'winter';
    else if (month >= 3 && month <= 5) season = 'spring';
    else if (month >= 6 && month <= 8) season = 'summer';
    else season = 'fall';
  }
  
  const statusMap = {
    'Currently Airing': 'ONGOING',
    'Finished Airing': 'FINISHED',
    'Not yet aired': 'UPCOMING'
  };
  
  const genres = [
    ...(jikanAnime.genres || []).map(g => g.name),
    ...(jikanAnime.themes || []).map(t => t.name)
  ];
  
  // Extract broadcast day
  let broadcastDay = null;
  if (jikanAnime.broadcast?.day) {
    const dayMap = {
      'mondays': 'Monday', 'tuesdays': 'Tuesday', 'wednesdays': 'Wednesday',
      'thursdays': 'Thursday', 'fridays': 'Friday', 'saturdays': 'Saturday',
      'sundays': 'Sunday'
    };
    broadcastDay = dayMap[jikanAnime.broadcast.day.toLowerCase()] || null;
  }
  
  return {
    id: `mal-${jikanAnime.mal_id}`,
    imdb_id: null, // Will need to be matched later
    mal_id: jikanAnime.mal_id,
    name: jikanAnime.title,
    description: jikanAnime.synopsis,
    poster: jikanAnime.images?.jpg?.large_image_url,
    background: jikanAnime.images?.jpg?.large_image_url,
    rating: jikanAnime.score || null,
    year,
    season,
    status: statusMap[jikanAnime.status] || 'UNKNOWN',
    episodes: jikanAnime.episodes || null,
    episodeCount: jikanAnime.episodes || null,
    runtime: jikanAnime.duration,
    genres: [...new Set(genres)],
    studios: (jikanAnime.studios || []).map(s => s.name),
    broadcastDay,
    animeType: jikanAnime.type || 'TV',
    subtype: jikanAnime.type?.toLowerCase() || 'tv'
  };
}

// ========== MAIN UPDATE FUNCTIONS ==========

async function runQualityControl(catalogData) {
  console.log('\n📋 Running Quality Control on Currently Airing catalog...\n');
  
  const airingAnime = catalogData.catalog.filter(a => a.status === 'ONGOING');
  log(`Found ${airingAnime.length} anime marked as ONGOING`);
  
  const statusChanges = [];
  const removedFromAiring = [];
  let checked = 0;
  
  for (const anime of airingAnime) {
    checked++;
    process.stdout.write(`\rChecking ${checked}/${airingAnime.length}: ${anime.name.substring(0, 40).padEnd(40)}...`);
    
    const status = await checkAiringStatus(anime);
    
    if (status && status.currentStatus !== 'ONGOING') {
      statusChanges.push({
        anime,
        oldStatus: anime.status,
        newStatus: status.currentStatus,
        reason: `Jikan reports: ${status.currentStatus}`
      });
      
      // Update the anime in catalog
      const idx = catalogData.catalog.findIndex(a => a.id === anime.id);
      if (idx !== -1) {
        catalogData.catalog[idx].status = status.currentStatus;
        if (status.episodeCount) {
          catalogData.catalog[idx].episodeCount = status.episodeCount;
          catalogData.catalog[idx].episodes = status.episodeCount;
        }
      }
      
      removedFromAiring.push(anime);
    }
    
    // Also update broadcast day if it changed
    if (status && status.broadcastDay && status.broadcastDay !== anime.broadcastDay) {
      const idx = catalogData.catalog.findIndex(a => a.id === anime.id);
      if (idx !== -1) {
        catalogData.catalog[idx].broadcastDay = status.broadcastDay;
      }
    }
  }
  
  console.log('\n');
  
  if (statusChanges.length > 0) {
    log(`Found ${statusChanges.length} anime no longer airing:`, 'warning');
    for (const change of statusChanges) {
      log(`  ${change.anime.name}: ${change.oldStatus} → ${change.newStatus}`);
    }
  } else {
    log('All currently airing anime are still airing', 'success');
  }
  
  return { statusChanges, removedFromAiring };
}

async function runNonAnimeDetection(catalogData) {
  console.log('\n🔍 Detecting non-anime entries...\n');
  
  const newNonAnime = [];
  let checked = 0;
  
  // Only check anime that aren't already in the blacklist
  const toCheck = catalogData.catalog.filter(a => {
    const id = a.id || a.imdb_id;
    return !KNOWN_NON_ANIME.has(id);
  });
  
  // Quick checks first (no API calls)
  const suspicious = [];
  
  for (const anime of toCheck) {
    const studioCheck = checkWesternStudio(anime);
    const keywordCheck = checkWesternKeywords(anime);
    
    if (studioCheck.isWestern || keywordCheck.hasWesternKeyword) {
      suspicious.push(anime);
    }
  }
  
  log(`Found ${suspicious.length} suspicious entries to verify`, 'debug');
  
  // Deep check suspicious entries
  for (const anime of suspicious) {
    checked++;
    process.stdout.write(`\rVerifying ${checked}/${suspicious.length}: ${anime.name.substring(0, 40).padEnd(40)}...`);
    
    const result = await detectNonAnime(anime);
    
    if (result.isNonAnime) {
      newNonAnime.push(result);
    }
  }
  
  console.log('\n');
  
  if (newNonAnime.length > 0) {
    log(`Found ${newNonAnime.length} new non-anime entries:`, 'warning');
    for (const entry of newNonAnime) {
      log(`  ${entry.name} (${entry.id}) - ${entry.reasons.join(', ')}`);
    }
  } else {
    log('No new non-anime entries found', 'success');
  }
  
  return newNonAnime;
}

async function runMetadataEnrichment(catalogData) {
  console.log('\n✨ Enriching metadata for incomplete entries...\n');
  
  const airingAnime = catalogData.catalog.filter(a => a.status === 'ONGOING');
  const needsEnrichment = [];
  
  // Analyze all airing anime for missing metadata
  for (const anime of airingAnime) {
    const { issues, missing } = analyzeMetadata(anime);
    
    // Check poster URL
    if (anime.poster) {
      const posterStatus = await checkPosterUrl(anime.poster);
      if (posterStatus.status !== 'ok') {
        issues.push('broken_poster');
        missing.poster = true;
      }
    }
    
    if (issues.length > 0) {
      needsEnrichment.push({ anime, issues, missing });
    }
  }
  
  log(`Found ${needsEnrichment.length} anime needing enrichment`);
  
  if (needsEnrichment.length === 0) {
    log('All airing anime have complete metadata', 'success');
    return { posterOverrides: {}, metadataOverrides: {} };
  }
  
  const posterOverrides = {};
  const metadataOverrides = {};
  let enriched = 0;
  
  for (const { anime, issues, missing } of needsEnrichment) {
    enriched++;
    process.stdout.write(`\rEnriching ${enriched}/${needsEnrichment.length}: ${anime.name.substring(0, 40).padEnd(40)}...`);
    
    const enrichment = await enrichAnime(anime, missing);
    
    if (enrichment.poster) {
      posterOverrides[anime.id] = enrichment.poster;
    }
    
    if (Object.keys(enrichment.metadata).length > 0) {
      metadataOverrides[anime.id] = enrichment.metadata;
    }
    
    await sleep(300); // Rate limiting
  }
  
  console.log('\n');
  
  log(`Generated ${Object.keys(posterOverrides).length} poster overrides`, 'success');
  log(`Generated ${Object.keys(metadataOverrides).length} metadata overrides`, 'success');
  
  return { posterOverrides, metadataOverrides };
}

async function runNewAnimeDiscovery(catalogData) {
  console.log('\n🆕 Discovering new anime...\n');
  
  const newAnimeFromJikan = await fetchNewAnimeFromJikan();
  
  // Find anime not in our catalog
  const existingMalIds = new Set(
    catalogData.catalog
      .filter(a => a.mal_id)
      .map(a => a.mal_id)
  );
  
  const newAnime = [];
  
  for (const jikanAnime of newAnimeFromJikan) {
    if (!existingMalIds.has(jikanAnime.mal_id)) {
      const meta = jikanToMeta(jikanAnime);
      
      // Check if it's actually anime (not Western animation)
      const detection = await detectNonAnime(meta);
      
      if (!detection.isNonAnime) {
        newAnime.push(meta);
        log(`New: ${meta.name}`, 'debug');
      } else {
        log(`Skipped (non-anime): ${meta.name}`, 'debug');
      }
    }
  }
  
  log(`Found ${newAnime.length} new anime to add`, 'success');
  
  return newAnime;
}

// ========== WORKER FILE UPDATE ==========

function generateOverrideCode(posterOverrides, metadataOverrides) {
  let code = '';
  
  if (Object.keys(posterOverrides).length > 0) {
    code += '\n// === AUTO-GENERATED POSTER OVERRIDES ===\n';
    for (const [id, url] of Object.entries(posterOverrides)) {
      code += `  '${id}': '${url}',\n`;
    }
  }
  
  if (Object.keys(metadataOverrides).length > 0) {
    code += '\n// === AUTO-GENERATED METADATA OVERRIDES ===\n';
    for (const [id, meta] of Object.entries(metadataOverrides)) {
      code += `  '${id}': { // Auto-generated\n`;
      for (const [key, value] of Object.entries(meta)) {
        if (Array.isArray(value)) {
          code += `    ${key}: ${JSON.stringify(value)},\n`;
        } else if (typeof value === 'string') {
          const escaped = value.replace(/'/g, "\\'").replace(/\n/g, '\\n');
          code += `    ${key}: '${escaped}',\n`;
        } else {
          code += `    ${key}: ${value},\n`;
        }
      }
      code += `  },\n`;
    }
  }
  
  return code;
}

// ========== MAIN ==========

async function main() {
  console.log('═'.repeat(60));
  console.log('  AnimeStream Incremental Update');
  console.log('═'.repeat(60));
  console.log('');
  
  const flags = [];
  if (DRY_RUN) flags.push('DRY RUN');
  if (VERBOSE) flags.push('VERBOSE');
  if (QUALITY_CONTROL_ONLY) flags.push('QC ONLY');
  if (NEW_ANIME_ONLY) flags.push('NEW ANIME ONLY');
  if (ENRICH_ONLY) flags.push('ENRICH ONLY');
  if (APPLY_CHANGES) flags.push('APPLY CHANGES');
  
  // Display current season info
  const currentSeason = getCurrentSeason();
  const nextSeason = getNextSeason(currentSeason);
  
  console.log(`Mode: ${flags.length > 0 ? flags.join(', ') : 'FULL UPDATE'}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Current Season: ${currentSeason.display}`);
  console.log(`Next Season: ${nextSeason.display}`);
  console.log('');
  
  // Load existing data
  const catalogData = loadCatalog();
  const filterOptions = loadFilterOptions();
  
  log(`Loaded catalog: ${catalogData.catalog.length} anime`);
  log(`Build date: ${catalogData.buildDate}`);
  console.log('');
  
  // Results tracking
  const results = {
    qualityControl: null,
    nonAnimeDetection: null,
    enrichment: null,
    newAnime: null,
    filterOptionsUpdated: false
  };
  
  // Run selected operations
  try {
    // 1. Quality Control (always run unless only doing something else)
    if (!NEW_ANIME_ONLY && !ENRICH_ONLY) {
      results.qualityControl = await runQualityControl(catalogData);
    }
    
    // 2. New Anime Discovery
    if (!QUALITY_CONTROL_ONLY && !ENRICH_ONLY) {
      results.newAnime = await runNewAnimeDiscovery(catalogData);
      
      // Add new anime to catalog
      if (results.newAnime && results.newAnime.length > 0) {
        catalogData.catalog.push(...results.newAnime);
        catalogData.stats.totalAnime = catalogData.catalog.length;
      }
    }
    
    // 3. Non-Anime Detection (run on new entries)
    if (!QUALITY_CONTROL_ONLY && !ENRICH_ONLY) {
      results.nonAnimeDetection = await runNonAnimeDetection(catalogData);
    }
    
    // 4. Metadata Enrichment
    if (!QUALITY_CONTROL_ONLY && !NEW_ANIME_ONLY) {
      results.enrichment = await runMetadataEnrichment(catalogData);
    }
    
    // 5. Update filter options (always after any changes)
    if (results.qualityControl?.statusChanges?.length > 0 ||
        results.newAnime?.length > 0) {
      console.log('\n📊 Updating filter options...\n');
      const updatedFilters = updateFilterOptions(catalogData.catalog, filterOptions);
      saveFilterOptions(updatedFilters);
      results.filterOptionsUpdated = true;
    }
    
    // Save catalog
    saveCatalog(catalogData);
    
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'error');
    console.error(error);
    process.exit(1);
  }
  
  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('  Summary');
  console.log('═'.repeat(60));
  
  if (results.qualityControl) {
    console.log(`\n  Quality Control:`);
    console.log(`    - Status changes: ${results.qualityControl.statusChanges.length}`);
    console.log(`    - Removed from airing: ${results.qualityControl.removedFromAiring.length}`);
  }
  
  if (results.newAnime) {
    console.log(`\n  New Anime:`);
    console.log(`    - Added: ${results.newAnime.length}`);
  }
  
  if (results.nonAnimeDetection) {
    console.log(`\n  Non-Anime Detection:`);
    console.log(`    - Found: ${results.nonAnimeDetection.length}`);
  }
  
  if (results.enrichment) {
    console.log(`\n  Metadata Enrichment:`);
    console.log(`    - Poster overrides: ${Object.keys(results.enrichment.posterOverrides).length}`);
    console.log(`    - Metadata overrides: ${Object.keys(results.enrichment.metadataOverrides).length}`);
    
    if (Object.keys(results.enrichment.posterOverrides).length > 0 ||
        Object.keys(results.enrichment.metadataOverrides).length > 0) {
      console.log('\n  Generated override code:');
      console.log(generateOverrideCode(results.enrichment.posterOverrides, results.enrichment.metadataOverrides));
    }
  }
  
  if (results.filterOptionsUpdated) {
    console.log(`\n  Filter Options: Updated`);
  }
  
  console.log('\n' + '═'.repeat(60));
  console.log(`  Total anime in catalog: ${catalogData.catalog.length}`);
  console.log('═'.repeat(60) + '\n');
  
  if (DRY_RUN) {
    log('DRY RUN complete - no changes saved', 'warning');
  } else {
    log('Update complete!', 'success');
  }
}

main().catch(console.error);
