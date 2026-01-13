#!/usr/bin/env node
/**
 * Database Builder
 * 
 * Creates the anime database with proper genre extraction.
 * Uses the anime-offline-database, IMDB mappings, and Cinemeta for rich metadata.
 * 
 * Usage: 
 *   node scripts/build-test-database.js         # Build 100 anime (test mode)
 *   node scripts/build-test-database.js --full  # Build full database
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const OUTPUT_DIR = path.join(__dirname, '..', 'data');

// Parse command line args
const args = process.argv.slice(2);
const FULL_BUILD = args.includes('--full');
const BUILD_LIMIT = FULL_BUILD ? Infinity : 100;

// URLs for data sources - use GitHub releases instead of raw.githubusercontent
const ANIME_DB_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const FRIBB_IMDB_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io/meta';

// Rate limiting for Cinemeta (be respectful)
const CINEMETA_DELAY_MS = 100; // 100ms between requests

// Tag to genre mapping (comprehensive)
const TAG_TO_GENRE = {
  'action': 'Action',
  'adventure': 'Adventure',
  'comedy': 'Comedy',
  'drama': 'Drama',
  'fantasy': 'Fantasy',
  'horror': 'Horror',
  'mystery': 'Mystery',
  'psychological': 'Psychological',
  'romance': 'Romance',
  'sci-fi': 'Sci-Fi',
  'science fiction': 'Sci-Fi',
  'slice of life': 'Slice of Life',
  'sports': 'Sports',
  'supernatural': 'Supernatural',
  'thriller': 'Thriller',
  'suspense': 'Thriller',
  'mecha': 'Mecha',
  'music': 'Music',
  'school': 'School',
  'school life': 'School',
  'seinen': 'Seinen',
  'shoujo': 'Shoujo',
  'shounen': 'Shounen',
  'shonen': 'Shounen',
  'josei': 'Josei',
  'isekai': 'Isekai',
  'martial arts': 'Martial Arts',
  'military': 'Military',
  'parody': 'Parody',
  'historical': 'Historical',
  'demons': 'Demons',
  'magic': 'Magic',
  'vampire': 'Vampire',
  'space': 'Space',
  'game': 'Game',
  'harem': 'Harem',
  'ecchi': 'Ecchi',
  'kids': 'Kids',
  'super power': 'Super Power',
  'superpower': 'Super Power',
  'samurai': 'Samurai',
  'cars': 'Cars',
  'racing': 'Cars',
  'police': 'Police',
  'award winning': 'Award Winning',
  'gourmet': 'Gourmet',
  'cooking': 'Gourmet',
  'workplace': 'Workplace',
  'mythology': 'Mythology',
  'reincarnation': 'Reincarnation',
  'time travel': 'Time Travel',
  'survival': 'Survival',
  'idols': 'Idols',
  'idol': 'Idols',
  'mahou shoujo': 'Mahou Shoujo',
  'magical girl': 'Mahou Shoujo',
  'reverse harem': 'Reverse Harem',
  'boys love': 'Boys Love',
  'shounen ai': 'Boys Love',
  'yaoi': 'Boys Love',
  'girls love': 'Girls Love',
  'shoujo ai': 'Girls Love',
  'yuri': 'Girls Love',
  'iyashikei': 'Iyashikei',
  'adult cast': 'Adult Cast',
  'anthropomorphic': 'Anthropomorphic',
  'avant garde': 'Avant Garde',
  'childcare': 'Childcare',
  'combat sports': 'Combat Sports',
  'crossdressing': 'Crossdressing',
  'delinquents': 'Delinquents',
  'detective': 'Detective',
  'educational': 'Educational',
  'gag humor': 'Comedy',
  'gore': 'Gore',
  'hentai': 'Hentai',
  'high stakes game': 'Game',
  'love polygon': 'Romance',
  'medical': 'Medical',
  'memoir': 'Memoir',
  'organized crime': 'Crime',
  'otaku culture': 'Otaku',
  'pets': 'Pets',
  'racing': 'Racing',
  'romantic subtext': 'Romance',
  'showbiz': 'Showbiz',
  'strategy game': 'Game',
  'team sports': 'Sports',
  'video game': 'Game',
  'villainess': 'Villainess'
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch JSON from URL (handles redirects)
 */
function fetchJson(url, silent = false) {
  return new Promise((resolve, reject) => {
    if (!silent) console.log(`Fetching: ${url}`);
    
    const makeRequest = (targetUrl) => {
      const protocol = targetUrl.startsWith('https') ? https : require('http');
      
      protocol.get(targetUrl, { headers: { 'User-Agent': 'AnimeStream/1.0' } }, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          if (!silent) console.log(`   Redirecting to: ${res.headers.location}`);
          return makeRequest(res.headers.location);
        }
        
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            if (!silent) console.error('JSON parse error. First 200 chars:', data.substring(0, 200));
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
      }).on('error', reject);
    };
    
    makeRequest(url);
  });
}

/**
 * Fetch metadata from Cinemeta for an IMDB ID
 * Returns: { logo, background, cast, cinemataGenres, description }
 */
async function fetchCinemeta(imdbId, type = 'series') {
  try {
    const url = `${CINEMETA_BASE}/${type}/${imdbId}.json`;
    const data = await fetchJson(url, true);
    
    if (!data || !data.meta) return null;
    
    const meta = data.meta;
    return {
      logo: meta.logo || null,
      background: meta.background || null,
      cast: meta.cast ? meta.cast.slice(0, 10) : [], // Top 10 cast
      cinemataGenres: meta.genres || [],
      description: meta.description || null,
      name: meta.name || null, // English name from Cinemeta
      releaseInfo: meta.releaseInfo || null
    };
  } catch (err) {
    // Silently fail - Cinemeta might not have this anime
    return null;
  }
}

/**
 * Extract MAL ID from sources
 */
function extractMalId(sources) {
  for (const source of sources || []) {
    const match = source.match(/myanimelist\.net\/anime\/(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return null;
}

/**
 * Extract Kitsu ID from sources
 */
function extractKitsuId(sources) {
  for (const source of sources || []) {
    const match = source.match(/kitsu\.app\/anime\/(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return null;
}

/**
 * Extract genres from tags
 */
function extractGenres(tags) {
  if (!tags || !Array.isArray(tags)) return [];
  
  const genres = new Set();
  
  for (const tag of tags) {
    const normalizedTag = tag.toLowerCase().trim();
    
    // Direct match
    if (TAG_TO_GENRE[normalizedTag]) {
      genres.add(TAG_TO_GENRE[normalizedTag]);
      continue;
    }
    
    // Try without spaces/hyphens
    const noSpaces = normalizedTag.replace(/[\s-]/g, '');
    for (const [key, value] of Object.entries(TAG_TO_GENRE)) {
      if (key.replace(/[\s-]/g, '') === noSpaces) {
        genres.add(value);
        break;
      }
    }
  }
  
  return Array.from(genres).sort();
}

/**
 * Get best English title
 */
function getBestTitle(anime) {
  // Prefer English title if it looks good
  const candidates = [anime.title, ...(anime.synonyms || [])];
  
  // Simple heuristic: prefer titles without CJK characters
  const cjkRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  
  for (const title of candidates) {
    if (!cjkRegex.test(title)) {
      return title;
    }
  }
  
  return anime.title;
}

/**
 * Convert anime entry to Stremio meta format
 */
function convertToStremioMeta(anime, imdbId) {
  const malId = extractMalId(anime.sources);
  const kitsuId = extractKitsuId(anime.sources);
  
  if (!malId) return null;
  
  const genres = extractGenres(anime.tags);
  const title = getBestTitle(anime);
  
  // Determine subtype
  let subtype = 'TV';
  if (anime.type === 'MOVIE') subtype = 'movie';
  else if (anime.type === 'OVA') subtype = 'OVA';
  else if (anime.type === 'ONA') subtype = 'ONA';
  else if (anime.type === 'SPECIAL') subtype = 'Special';
  
  // Get score (0-10 scale)
  const score = anime.score?.median || anime.score?.arithmeticMean || null;
  
  // Calculate runtime
  let runtime = null;
  if (anime.duration?.value) {
    const minutes = Math.round(anime.duration.value / 60);
    if (minutes > 0) runtime = `${minutes} min`;
  }
  
  // Get season info
  const year = anime.animeSeason?.year || null;
  const season = anime.animeSeason?.season?.toLowerCase() || null;
  
  return {
    id: imdbId || `mal-${malId}`,
    imdb_id: imdbId || null,
    kitsu_id: kitsuId,
    mal_id: malId,
    type: 'series',
    name: title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: null, // Will be fetched on-demand from Jikan
    year,
    season: season !== 'undefined' ? season : null,
    status: anime.status || 'UNKNOWN',
    rating: score,
    poster: anime.picture || null,
    background: null,
    logo: null, // Will be filled from Cinemeta
    cast: [], // Will be filled from Cinemeta
    genres: genres.length > 0 ? genres : undefined,
    episodeCount: anime.episodes || null,
    runtime,
    ageRating: null,
    subtype,
    popularity: null
  };
}

/**
 * Enrich anime entry with Cinemeta data
 */
function enrichWithCinemeta(meta, cinemata) {
  if (!cinemata) return meta;
  
  // Use Cinemeta's English name if available and better
  if (cinemata.name && !meta.name.includes(cinemata.name)) {
    // Keep our name but store Cinemeta's as alias
    meta.cinemataName = cinemata.name;
  }
  
  // Logo (stylized title image) - this is the key feature!
  if (cinemata.logo) {
    meta.logo = cinemata.logo;
  }
  
  // Background/fanart
  if (cinemata.background) {
    meta.background = cinemata.background;
  }
  
  // Cast (actors/voice actors)
  if (cinemata.cast && cinemata.cast.length > 0) {
    meta.cast = cinemata.cast;
  }
  
  // Merge genres (prefer Cinemeta's as they're more standardized for Stremio)
  if (cinemata.cinemataGenres && cinemata.cinemataGenres.length > 0) {
    // Use Cinemeta genres but also keep our anime-specific ones
    const cinemataSet = new Set(cinemata.cinemataGenres);
    const ourSet = new Set(meta.genres || []);
    
    // Add Cinemeta genres first (they show better in Stremio)
    const merged = [...cinemata.cinemataGenres];
    
    // Add our anime-specific genres that Cinemeta might not have
    for (const g of meta.genres || []) {
      if (!cinemataSet.has(g)) {
        merged.push(g);
      }
    }
    
    meta.genres = merged.slice(0, 10); // Limit to 10 genres
  }
  
  // Description (use Cinemeta if we don't have one)
  if (cinemata.description && !meta.description) {
    meta.description = cinemata.description;
  }
  
  return meta;
}

/**
 * Main build function
 */
async function buildTestDatabase() {
  console.log('='.repeat(60));
  console.log('  AnimeStream Database Builder');
  console.log('  With Cinemeta enrichment for logos & metadata');
  console.log('='.repeat(60));
  if (FULL_BUILD) {
    console.log('  Mode: FULL BUILD (all anime)');
  } else {
    console.log(`  Mode: TEST (${BUILD_LIMIT} entries)`);
  }
  console.log('');
  
  try {
    // Fetch anime-offline-database
    console.log('Step 1: Fetching anime-offline-database...');
    const animeDb = await fetchJson(ANIME_DB_URL);
    console.log(`   Found ${animeDb.data.length} total anime`);
    
    // Fetch Fribb IMDB mappings
    console.log('Step 2: Fetching IMDB mappings...');
    const fribbData = await fetchJson(FRIBB_IMDB_URL);
    console.log(`   Found ${fribbData.length} IMDB mappings`);
    
    // Build MAL -> IMDB map
    const imdbMap = new Map();
    for (const entry of fribbData) {
      if (entry.mal_id && entry.imdb_id) {
        imdbMap.set(entry.mal_id, entry.imdb_id);
      }
    }
    console.log(`   ${imdbMap.size} MAL -> IMDB mappings loaded`);
    
    // Filter to high-quality anime with IMDB IDs
    console.log('Step 3: Processing anime...');
    
    // First, filter to anime with high scores and IMDB IDs
    const filtered = animeDb.data
      .filter(a => {
        const malId = extractMalId(a.sources);
        if (!malId) return false;
        
        // Must have IMDB ID
        const imdbId = imdbMap.get(malId);
        if (!imdbId) return false;
        
        // Must have decent score
        const score = a.score?.median || a.score?.arithmeticMean || 0;
        if (score < 7.0) return false;
        
        // Must be TV or Movie
        if (!['TV', 'MOVIE'].includes(a.type)) return false;
        
        // Must have tags (for genres)
        if (!a.tags || a.tags.length === 0) return false;
        
        return true;
      })
      .sort((a, b) => {
        const scoreA = a.score?.median || a.score?.arithmeticMean || 0;
        const scoreB = b.score?.median || b.score?.arithmeticMean || 0;
        return scoreB - scoreA; // Highest first
      })
      .slice(0, BUILD_LIMIT);
    
    console.log(`   Selected ${filtered.length} high-quality anime`);
    
    // Debug: Show tags from first anime
    if (filtered.length > 0) {
      console.log('');
      console.log('   Sample anime tags:');
      console.log(`   "${filtered[0].title}": ${filtered[0].tags.slice(0, 5).join(', ')}...`);
    }
    
    // Convert to Stremio format
    const catalog = [];
    let genreCount = 0;
    
    for (const anime of filtered) {
      const malId = extractMalId(anime.sources);
      const imdbId = imdbMap.get(malId);
      const meta = convertToStremioMeta(anime, imdbId);
      
      if (meta) {
        catalog.push(meta);
        if (meta.genres && meta.genres.length > 0) {
          genreCount++;
        }
      }
    }
    
    console.log(`   Converted ${catalog.length} anime to Stremio format`);
    console.log(`   ${genreCount} anime have genres`);
    
    // Step 4: Enrich with Cinemeta data (logos, backgrounds, cast)
    console.log('');
    console.log('Step 4: Fetching Cinemeta data for logos & metadata...');
    let cinemataSuccess = 0;
    let logoCount = 0;
    let castCount = 0;
    
    for (let i = 0; i < catalog.length; i++) {
      const meta = catalog[i];
      
      // Progress indicator
      if ((i + 1) % 10 === 0 || i === catalog.length - 1) {
        process.stdout.write(`\r   Processing ${i + 1}/${catalog.length}...`);
      }
      
      if (meta.imdb_id) {
        const type = meta.subtype === 'movie' ? 'movie' : 'series';
        const cinemata = await fetchCinemeta(meta.imdb_id, type);
        
        if (cinemata) {
          enrichWithCinemeta(meta, cinemata);
          cinemataSuccess++;
          if (meta.logo) logoCount++;
          if (meta.cast && meta.cast.length > 0) castCount++;
        }
        
        // Rate limiting - be respectful to Cinemeta
        await sleep(CINEMETA_DELAY_MS);
      }
    }
    
    console.log(''); // New line after progress
    console.log(`   Cinemeta enrichment: ${cinemataSuccess}/${catalog.length} successful`);
    console.log(`   Logos found: ${logoCount}`);
    console.log(`   Cast found: ${castCount}`);
    
    // Show sample with logos
    const withLogos = catalog.filter(a => a.logo);
    if (withLogos.length > 0) {
      console.log('');
      console.log('   Sample anime with logos:');
      for (const a of withLogos.slice(0, 3)) {
        console.log(`   - ${a.name}: ${a.logo.substring(0, 60)}...`);
      }
    }
    
    // Build output
    const output = {
      buildDate: new Date().toISOString(),
      totalAnime: catalog.length,
      catalog
    };
    
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Write uncompressed JSON
    const jsonPath = path.join(OUTPUT_DIR, 'catalog.json');
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    console.log(`\n   Wrote: ${jsonPath}`);
    
    // Write compressed JSON
    const gzPath = path.join(OUTPUT_DIR, 'catalog.json.gz');
    const compressed = zlib.gzipSync(JSON.stringify(output));
    fs.writeFileSync(gzPath, compressed);
    console.log(`   Wrote: ${gzPath} (${(compressed.length / 1024).toFixed(1)} KB)`);
    
    // Generate filter options
    const genreCounts = {};
    const movieGenreCounts = {};
    const seasonCounts = {};
    let seriesCount = 0;
    let movieCount = 0;
    
    for (const meta of catalog) {
      // Count by type
      if (meta.subtype === 'movie') {
        movieCount++;
        if (meta.genres) {
          for (const g of meta.genres) {
            movieGenreCounts[g] = (movieGenreCounts[g] || 0) + 1;
          }
        }
      } else {
        seriesCount++;
        if (meta.genres) {
          for (const g of meta.genres) {
            genreCounts[g] = (genreCounts[g] || 0) + 1;
          }
        }
        
        // Count seasons
        if (meta.year && meta.season) {
          const key = `${meta.year} - ${meta.season.charAt(0).toUpperCase() + meta.season.slice(1)}`;
          seasonCounts[key] = (seasonCounts[key] || 0) + 1;
        }
      }
    }
    
    // Sort genres by count
    const sortedGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([g, c]) => g);
    
    const sortedMovieGenres = Object.entries(movieGenreCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([g, c]) => g);
    
    const sortedSeasons = Object.entries(seasonCounts)
      .sort((a, b) => {
        // Parse "2025 - Winter" format
        const [yearA, seasonA] = a[0].split(' - ');
        const [yearB, seasonB] = b[0].split(' - ');
        if (yearA !== yearB) return parseInt(yearB) - parseInt(yearA);
        const order = { Winter: 4, Fall: 3, Summer: 2, Spring: 1 };
        return (order[seasonB] || 0) - (order[seasonA] || 0);
      })
      .map(([s, c]) => s);
    
    const filterOptions = {
      stats: {
        totalAnime: catalog.length,
        totalSeries: seriesCount,
        totalMovies: movieCount,
        genreCount: Object.keys(genreCounts).length,
        seasonCount: Object.keys(seasonCounts).length
      },
      genres: {
        list: sortedGenres,
        withCounts: sortedGenres.map(g => `${g} (${genreCounts[g]})`)
      },
      movieGenres: {
        list: sortedMovieGenres,
        withCounts: sortedMovieGenres.map(g => `${g} (${movieGenreCounts[g]})`)
      },
      seasons: {
        list: sortedSeasons,
        withCounts: sortedSeasons.map(s => `${s} (${seasonCounts[s]})`)
      },
      weekdays: {
        list: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        withCounts: []
      }
    };
    
    const filterPath = path.join(OUTPUT_DIR, 'filter-options.json');
    fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
    console.log(`   Wrote: ${filterPath}`);
    
    console.log('');
    console.log('='.repeat(60));
    console.log('  Build Complete!');
    console.log('='.repeat(60));
    console.log(`  Total: ${catalog.length} anime`);
    console.log(`  Series: ${seriesCount}, Movies: ${movieCount}`);
    console.log(`  Genres: ${Object.keys(genreCounts).length}`);
    console.log(`  Seasons: ${Object.keys(seasonCounts).length}`);
    console.log('');
    
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Run
buildTestDatabase();
