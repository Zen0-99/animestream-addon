#!/usr/bin/env node
/**
 * Database Builder Script
 * 
 * Processes the anime-offline-database.json into a Stremio-optimized catalog.
 * Includes IMDB ID mappings for stream addon compatibility (Torrentio, Comet, etc.)
 * 
 * Usage: node scripts/build-database.js
 *        node scripts/build-database.js --test  (first 1000 entries only)
 * 
 * Output: 
 *   - data/catalog.json.gz (compressed catalog)
 *   - data/catalog.json (uncompressed, for debugging)
 *   - data/filter-options.json (genres, seasons with counts)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// TEST MODE: Run with --test flag for smaller dataset
const TEST_MODE = process.argv.includes('--test');
const TEST_LIMIT = 1000;

// Configuration
const CONFIG = {
  inputFile: path.join(__dirname, '..', 'data', 'anime-offline-database.json'),
  outputDir: path.join(__dirname, '..', 'data'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  catalogGzFile: TEST_MODE ? 'catalog-test.json.gz' : 'catalog.json.gz',
  filterOptionsFile: 'filter-options.json',
  
  // Minimum score to include (filters out obscure/unrated content)
  minScore: 0, // Include all for now, filter in catalog handler
  
  // Types to include (TV = main series, MOVIE = films)
  includeTypes: ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'],
  
  // Status to include
  includeStatus: ['FINISHED', 'ONGOING', 'UPCOMING']
};

// Standard anime genres (normalized)
const STANDARD_GENRES = new Set([
  'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror', 'mystery',
  'psychological', 'romance', 'sci-fi', 'slice of life', 'sports', 'supernatural',
  'thriller', 'mecha', 'music', 'school', 'seinen', 'shoujo', 'shounen', 'josei',
  'isekai', 'martial arts', 'military', 'parody', 'historical', 'demons',
  'magic', 'vampire', 'space', 'game', 'harem', 'ecchi', 'kids', 'super power',
  'samurai', 'cars', 'police', 'dementia', 'suspense', 'award winning', 'gourmet',
  'workplace', 'mythology', 'performing arts', 'visual arts', 'reincarnation',
  'time travel', 'survival', 'idols', 'cgdct', 'iyashikei', 'mahou shoujo',
  'reverse harem', 'boys love', 'girls love'
]);

// Tag to genre mapping (common tags -> standardized genre names)
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
  'high school': 'School',
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
  'vampires': 'Vampire',
  'space': 'Space',
  'game': 'Game',
  'video game': 'Game',
  'harem': 'Harem',
  'ecchi': 'Ecchi',
  'kids': 'Kids',
  'super power': 'Super Power',
  'superpowers': 'Super Power',
  'samurai': 'Samurai',
  'cars': 'Cars',
  'racing': 'Cars',
  'police': 'Police',
  'award winning': 'Award Winning',
  'gourmet': 'Gourmet',
  'cooking': 'Gourmet',
  'workplace': 'Workplace',
  'mythology': 'Mythology',
  'performing arts': 'Performing Arts',
  'visual arts': 'Visual Arts',
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
  'cgdct': 'CGDCT',
  'cute girls doing cute things': 'CGDCT',
  'iyashikei': 'Iyashikei',
  'healing': 'Iyashikei'
};

/**
 * Detect if a title appears to be in English/Romanized form
 * Returns a score: higher = more likely proper English title
 */
function getEnglishScore(title) {
  if (!title) return 0;
  
  // Check for CJK characters (Chinese, Japanese, Korean)
  const cjkRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  const hasCJK = cjkRegex.test(title);
  
  // Check for Cyrillic (Russian, etc)
  const cyrillicRegex = /[\u0400-\u04FF]/;
  const hasCyrillic = cyrillicRegex.test(title);
  
  // Check for Arabic
  const arabicRegex = /[\u0600-\u06FF]/;
  const hasArabic = arabicRegex.test(title);
  
  // Check for Thai
  const thaiRegex = /[\u0E00-\u0E7F]/;
  const hasThai = thaiRegex.test(title);
  
  // Check for extended Latin (Turkish ç, ş, ğ, ı, etc; German ß, ü; etc.)
  const extendedLatinRegex = /[ç şğıüöäßàâèéêëîïôùûñ]/i;
  const hasExtendedLatin = extendedLatinRegex.test(title);
  
  if (hasCJK || hasCyrillic || hasArabic || hasThai) return 0;
  
  let score = 1; // Base score for ASCII text
  
  // Penalty for extended Latin characters (non-English European)
  if (hasExtendedLatin) score -= 3;
  
  // Bonus for starting with uppercase ASCII letters
  if (/^[A-Z]/.test(title)) score += 1;
  
  // Detect likely romanized Chinese/Japanese titles (patterns like "Bian", "Xia", "Qing", etc)
  // These use pinyin patterns uncommon in English
  const romanizedPatterns = /\b(Bian|Xia|Qing|Ying|Xiong|Jie|Zhi|Ren|Tian|Shi|Jiu|Xin|Yao|Yuan|Zhan|Feng|Long|Jing|Hua|Mei|Yan|Ling|Xue|Yue|Zhu|Hao|Wei|Guang|Jun|Qi|Kai|Xiao|Dao|Dian|Zhe|Huang|Lian|Nian|Wang|Wu|San|Shan|Dong|Qiang|Zhong|Bei|Nan|Shao|Shen|Pian|Wo|De|Ta|Ai|Bao|Cheng|Dou|Feng|Gao|Gen|Gong|Gu|Han|Hu|Ji|Jia|Jin|Kong|Li|Liu|Ma|Min|Mo|Nv|Pan|Peng|Pu|Ri|Rong|Su|Tang|Tong|Wai|Wan|Xing|Xu|Ying|Yong|Zhang|Zhao|Zheng|Zhou|Zhuan|Zi)\b/i;
  const isRomanized = romanizedPatterns.test(title);
  if (isRomanized) score -= 2; // Penalty for likely romanized titles
  
  // Bonus for common English words in title
  const englishWords = /\b(the|a|an|of|to|in|on|at|by|for|with|and|or|my|your|our|his|her|their|this|that|is|are|was|were|be|have|has|had|do|does|did|will|would|can|could|may|might|must|shall|should|hero|heroine|king|queen|prince|princess|knight|magic|world|story|tale|adventure|journey|love|war|battle|legend|dragon|sword|shield|life|death|light|dark|shadow|spirit|soul|dream|heaven|hell|devil|angel|god|demon|monster|beast|girl|boy|man|woman|child|kid|school|student|teacher|master|friend|enemy|secret|mystery|time|space|future|past|season|part|chapter|episode|movie|film|special|complete|final|one|piece|attack|titan|death|note|naruto|bleach|hunter|fullmetal|alchemist|code|geass|steins|gate|cowboy|bebop|neon|genesis|evangelion|sword|art|online|fairy|tail|mob|psycho)\b/i;
  const hasEnglishWords = englishWords.test(title);
  if (hasEnglishWords) score += 3;
  
  // Bonus for title case (first letter caps on each word)
  const words = title.split(/\s+/);
  const isTitleCase = words.every(w => /^[A-Z]/.test(w) || w.length <= 2);
  if (isTitleCase && words.length > 1) score += 1;
  
  // Small preference for shorter titles (less likely to be localized versions)
  // But only among reasonably short titles
  if (title.length <= 20) score += 1;
  if (title.length <= 15) score += 1;
  
  return score;
}

/**
 * Find the best English title from title + synonyms
 */
function findBestEnglishTitle(mainTitle, synonyms) {
  // Build list of all candidate titles
  const candidates = [mainTitle, ...(synonyms || [])];
  
  // Score each and find best
  let bestTitle = mainTitle;
  let bestScore = getEnglishScore(mainTitle);
  
  for (const syn of (synonyms || [])) {
    const score = getEnglishScore(syn);
    // Use strictly greater to prefer original when tied
    // But also prefer synonym if it's significantly better
    if (score > bestScore) {
      bestScore = score;
      bestTitle = syn;
    }
  }
  
  return bestTitle;
}

/**
 * Format time duration
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
 * Extract MAL ID from sources array
 */
function extractMalId(sources) {
  for (const source of sources) {
    const match = source.match(/myanimelist\.net\/anime\/(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return null;
}

/**
 * Extract Kitsu ID from sources array
 */
function extractKitsuId(sources) {
  for (const source of sources) {
    const match = source.match(/kitsu\.app\/anime\/(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return null;
}

/**
 * Extract AniList ID from sources array
 */
function extractAniListId(sources) {
  for (const source of sources) {
    const match = source.match(/anilist\.co\/anime\/(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return null;
}

/**
 * Extract genres from tags array
 * Filters to only standard anime genres
 */
function extractGenres(tags) {
  if (!tags || !Array.isArray(tags)) return [];
  
  const genres = new Set();
  
  for (const tag of tags) {
    const normalizedTag = tag.toLowerCase().trim();
    
    // Check if this tag maps to a standard genre
    if (TAG_TO_GENRE[normalizedTag]) {
      genres.add(TAG_TO_GENRE[normalizedTag]);
    }
  }
  
  return Array.from(genres).sort();
}

/**
 * Format season display name
 * e.g., "2025-winter" -> "2025 - Winter"
 */
function formatSeasonDisplay(year, season) {
  if (!year || !season || season === 'UNDEFINED') return null;
  const seasonCapitalized = season.charAt(0).toUpperCase() + season.slice(1).toLowerCase();
  return `${year} - ${seasonCapitalized}`;
}

/**
 * Calculate runtime string from duration
 */
function calculateRuntime(durationObj) {
  if (!durationObj || !durationObj.value) return null;
  const minutes = Math.round(durationObj.value / 60);
  if (minutes > 0) return `${minutes} min`;
  return null;
}

/**
 * Convert anime-offline-database entry to Stremio meta format
 */
function convertToStremioMeta(anime, imdbMappings, jikanData = null) {
  const malId = extractMalId(anime.sources);
  const kitsuId = extractKitsuId(anime.sources);
  const anilistId = extractAniListId(anime.sources);
  
  if (!malId) return null; // Need MAL ID as our primary identifier
  
  // Look up IMDB ID from mappings
  const imdbId = imdbMappings.get(malId) || null;
  
  // Extract genres from tags
  const genres = extractGenres(anime.tags);
  
  // Get score (use median as most reliable)
  let score = anime.score?.median || anime.score?.arithmeticMean || null;
  
  // Use Jikan data for broadcast info and aired date if available
  let broadcastDay = null;
  let airedFrom = null;
  
  if (jikanData) {
    broadcastDay = jikanData.broadcast?.day || null;
    airedFrom = jikanData.aired?.from || null;
  }
  
  // Check if this is a future release using UK time (GMT/BST)
  // If aired date is in the future, set rating to null
  const now = new Date();
  // Convert to UK time by getting UTC and applying offset
  // UK is UTC+0 in winter (GMT) and UTC+1 in summer (BST)
  const ukOffset = isDaylightSavingTime(now) ? 1 : 0;
  const ukNow = new Date(now.getTime() + (ukOffset * 60 * 60 * 1000));
  
  // If we have an exact aired date from Jikan, use that
  if (airedFrom) {
    const airedDate = new Date(airedFrom);
    if (airedDate > ukNow) {
      score = null; // Future release - show N/A
    }
  } else if (anime.animeSeason?.year && anime.animeSeason?.season) {
    // Fallback to season-based detection if no aired date
    // Use UK-based current date
    const currentYear = ukNow.getFullYear();
    const currentMonth = ukNow.getMonth(); // 0-11
    
    // Determine current season
    const seasonOrder = ['winter', 'spring', 'summer', 'fall'];
    const currentSeasonIndex = Math.floor(currentMonth / 3);
    
    const animeYear = anime.animeSeason.year;
    const animeSeason = anime.animeSeason.season.toLowerCase();
    const animeSeasonIndex = seasonOrder.indexOf(animeSeason);
    
    // If anime is in the future, set rating to null
    if (animeYear > currentYear || 
        (animeYear === currentYear && animeSeasonIndex > currentSeasonIndex)) {
      score = null; // Will display as N/A
    }
  }
  
  // Find best English title
  const displayTitle = findBestEnglishTitle(anime.title, anime.synonyms);
  
  // Build the Stremio meta object
  const meta = {
    id: `mal-${malId}`,
    type: 'series', // Stremio needs 'series' for proper rendering, but catalogs use 'anime'
    name: displayTitle,
    
    // IDs for cross-referencing
    malId,
    kitsuId,
    anilistId,
    imdb_id: imdbId, // Critical for Torrentio/Comet streams
    
    // Metadata
    poster: anime.picture || anime.thumbnail,
    background: anime.picture, // Use same image as background
    genres: genres.length > 0 ? genres : undefined,
    
    // Rating (displayed in runtime field to avoid IMDb logo)
    rating: score,
    
    // Release info
    year: anime.animeSeason?.year || null,
    season: anime.animeSeason?.season || null,
    releaseInfo: anime.animeSeason?.year?.toString() || null,
    
    // Broadcast info (for schedule filtering)
    broadcastDay: broadcastDay, // e.g., "Sundays", "Mondays"
    airedFrom: airedFrom, // ISO date string
    
    // Type info
    animeType: anime.type, // TV, MOVIE, OVA, ONA, SPECIAL
    status: anime.status,  // FINISHED, ONGOING, UPCOMING
    
    // Store raw tags for filtering (e.g., hentai detection)
    tags: anime.tags || [],
    
    // Episode count
    episodes: anime.episodes || null,
    
    // Duration per episode
    runtime: calculateRuntime(anime.duration),
    
    // Studios
    studios: anime.studios || [],
    
    // Synonyms/alternative titles for search (include original title if different)
    aliases: displayTitle !== anime.title 
      ? [anime.title, ...(anime.synonyms || [])]
      : (anime.synonyms || [])
  };
  
  // Only include non-null values
  return Object.fromEntries(
    Object.entries(meta).filter(([_, v]) => v !== null && v !== undefined)
  );
}

/**
 * Check if a date is in UK daylight saving time (BST)
 * BST runs from last Sunday of March to last Sunday of October
 */
function isDaylightSavingTime(date) {
  const year = date.getFullYear();
  
  // Find last Sunday of March
  const march31 = new Date(year, 2, 31);
  const lastSundayMarch = 31 - march31.getDay();
  const bstStart = new Date(year, 2, lastSundayMarch, 1, 0, 0);
  
  // Find last Sunday of October
  const oct31 = new Date(year, 9, 31);
  const lastSundayOct = 31 - oct31.getDay();
  const bstEnd = new Date(year, 9, lastSundayOct, 2, 0, 0);
  
  return date >= bstStart && date < bstEnd;
}

/**
 * Load IMDB mappings from multiple sources for maximum coverage:
 * 1. Fribb/anime-lists (static, ~7000 mappings)
 * 2. ARM API (dynamic, high coverage) - batched queries
 */
async function loadImdbMappings() {
  console.log('\n[DB] Loading IMDB mappings...');
  
  const mappings = new Map();
  const fetch = (await import('node-fetch')).default;
  
  // === SOURCE 1: Fribb/anime-lists (static file) ===
  console.log('   [1/2] Fetching from Fribb/anime-lists...');
  
  try {
    const response = await fetch(
      'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
      { timeout: 30000 }
    );
    
    if (response.ok) {
      const animeList = await response.json();
      
      for (const entry of animeList) {
        if (entry.mal_id && entry.imdb_id) {
          mappings.set(entry.mal_id, entry.imdb_id);
        }
      }
      
      console.log(`         Loaded ${mappings.size} mappings from anime-lists`);
    }
  } catch (err) {
    console.warn(`         Failed to fetch anime-lists: ${err.message}`);
  }
  
  return mappings;
}

/**
 * Fetch additional IMDB mappings from ARM API for entries missing IMDB
 * ARM has good coverage but requires individual requests (no batch support)
 * @param {Array} catalog - Array of anime entries
 * @param {Map} existingMappings - Already loaded IMDB mappings
 * @param {boolean} enableARM - Whether to make ARM API calls
 */
async function enrichWithArmMappings(catalog, existingMappings, enableARM = false) {
  // Find entries without IMDB IDs
  const needMapping = catalog.filter(anime => 
    !existingMappings.has(anime.malId) && anime.malId
  );
  
  if (needMapping.length === 0) {
    console.log('   [ARM] No additional mappings needed');
    return existingMappings;
  }
  
  console.log(`\n[INFO] ${needMapping.length} anime still need IMDB mappings`);
  
  if (!enableARM) {
    console.log('       ARM API enrichment disabled (would take too long for full build)');
    console.log('       To enable: set enableARM=true in enrichWithArmMappings call');
    return existingMappings;
  }
  
  const fetch = (await import('node-fetch')).default;
  console.log(`[ARM] Fetching IMDB IDs from ARM API (individual requests)...`);
  console.log('      This will take a while due to rate limiting (~3 req/sec)');
  
  let found = 0;
  let failed = 0;
  const rateLimit = 350; // ms between requests (roughly 3/sec)
  
  // Process individual requests
  for (let i = 0; i < needMapping.length; i++) {
    const anime = needMapping[i];
    
    try {
      const url = `https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${anime.malId}`;
      const response = await fetch(url, { timeout: 10000 });
      
      if (response.ok) {
        const result = await response.json();
        if (result?.imdb) {
          existingMappings.set(anime.malId, result.imdb);
          found++;
        }
      }
    } catch (err) {
      failed++;
    }
    
    // Progress update
    if ((i + 1) % 100 === 0 || i === needMapping.length - 1) {
      process.stdout.write(`\r      Progress: ${i + 1}/${needMapping.length} (found: ${found}, failed: ${failed})`);
    }
    
    // Rate limiting
    await new Promise(r => setTimeout(r, rateLimit));
  }
  
  console.log(`\n      [ARM] Found ${found} additional IMDB mappings`);
  
  return existingMappings;
}

/**
 * Fetch broadcast data from Jikan's schedule API
 * Returns a Map of malId -> { broadcast, aired }
 */
async function fetchBroadcastData() {
  console.log('\n[JIKAN] Fetching broadcast schedule data...');
  
  const broadcastData = new Map();
  const fetch = (await import('node-fetch')).default;
  
  // Jikan schedules endpoint supports filtering by day
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  for (const day of days) {
    let page = 1;
    let hasMore = true;
    let dayCount = 0;
    
    while (hasMore) {
      try {
        // Rate limit: 3 requests/second
        await new Promise(r => setTimeout(r, 350));
        
        const url = `https://api.jikan.moe/v4/schedules?filter=${day}&page=${page}`;
        const response = await fetch(url, { timeout: 15000 });
        
        if (!response.ok) {
          if (response.status === 429) {
            // Rate limited - wait and retry
            console.log(`\n   [RATE LIMITED] Waiting 5s before retry...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          break;
        }
        
        const data = await response.json();
        
        for (const anime of data.data || []) {
          if (anime.mal_id) {
            broadcastData.set(anime.mal_id, {
              broadcast: anime.broadcast || null,
              aired: anime.aired || null
            });
            dayCount++;
          }
        }
        
        // Check if there are more pages
        hasMore = data.pagination?.has_next_page || false;
        page++;
        
        // Safety limit - max 25 pages per day
        if (page > 25) break;
        
      } catch (err) {
        console.log(`\n   [ERR] Failed to fetch ${day} page ${page}: ${err.message}`);
        break;
      }
    }
    
    process.stdout.write(`\r   Fetched: ${day.padEnd(10)} (${dayCount} anime)`);
  }
  
  console.log(`\n   [JIKAN] Total broadcast data: ${broadcastData.size} anime`);
  
  return broadcastData;
}

/**
 * Main build function
 */
async function buildDatabase() {
  const startTime = Date.now();
  
  console.log('============================================================');
  console.log('           AnimeStream Database Builder');
  console.log('============================================================');
  console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'FULL'}`);
  console.log(`Input: ${CONFIG.inputFile}`);
  console.log(`Output: ${CONFIG.outputDir}`);
  console.log('');
  
  // Check input file exists
  if (!fs.existsSync(CONFIG.inputFile)) {
    console.error('[ERR] anime-offline-database.json not found!');
    console.error('   Run: npm run download-db');
    process.exit(1);
  }
  
  // Load IMDB mappings first
  const imdbMappings = await loadImdbMappings();
  
  // Fetch broadcast data from Jikan for currently airing anime
  const ENABLE_JIKAN_SCHEDULE = process.argv.includes('--schedule');
  let broadcastData = new Map();
  
  if (ENABLE_JIKAN_SCHEDULE) {
    broadcastData = await fetchBroadcastData();
  } else {
    console.log('\n[JIKAN] Schedule data fetching disabled (use --schedule to enable)');
    console.log('        Without schedule data, weekday filtering will not be available');
  }
  
  // Load anime-offline-database
  console.log('\n[LOAD] Loading anime-offline-database...');
  const rawData = fs.readFileSync(CONFIG.inputFile, 'utf8');
  const offlineDb = JSON.parse(rawData);
  
  console.log(`   Total entries: ${offlineDb.data.length}`);
  console.log(`   Last updated: ${offlineDb.lastUpdate}`);
  
  // Filter and convert entries
  console.log('\n[PROCESS] Processing entries...');
  
  let entries = offlineDb.data;
  
  // Apply test limit
  if (TEST_MODE) {
    entries = entries.slice(0, TEST_LIMIT);
    console.log(`   TEST MODE: Limited to ${TEST_LIMIT} entries`);
  }
  
  const catalog = [];
  const genreCounts = new Map();
  const seasonCounts = new Map();
  const studioCounts = new Map();
  const weekdayCounts = new Map(); // Track weekday counts for airing anime
  
  let skipped = { noMalId: 0, badType: 0, badStatus: 0 };
  
  for (let i = 0; i < entries.length; i++) {
    const anime = entries[i];
    
    // Filter by type
    if (!CONFIG.includeTypes.includes(anime.type)) {
      skipped.badType++;
      continue;
    }
    
    // Filter by status
    if (!CONFIG.includeStatus.includes(anime.status)) {
      skipped.badStatus++;
      continue;
    }
    
    // Get MAL ID first to lookup broadcast data
    const malId = extractMalId(anime.sources);
    const jikanData = malId ? broadcastData.get(malId) : null;
    
    // Convert to Stremio format with Jikan broadcast data
    const meta = convertToStremioMeta(anime, imdbMappings, jikanData);
    
    if (!meta) {
      skipped.noMalId++;
      continue;
    }
    
    catalog.push(meta);
    
    // Count genres
    if (meta.genres) {
      for (const genre of meta.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }
    
    // Count seasons
    if (meta.year && meta.season && meta.season !== 'UNDEFINED') {
      const seasonKey = `${meta.year}-${meta.season.toLowerCase()}`;
      seasonCounts.set(seasonKey, (seasonCounts.get(seasonKey) || 0) + 1);
    }
    
    // Count studios
    if (meta.studios) {
      for (const studio of meta.studios) {
        studioCounts.set(studio, (studioCounts.get(studio) || 0) + 1);
      }
    }
    
    // Count weekdays for ONGOING anime only (for schedule filtering)
    if (meta.status === 'ONGOING' && meta.broadcastDay) {
      // Normalize day format: "Sundays" -> "sunday"
      const dayNormalized = meta.broadcastDay.toLowerCase().replace(/s$/, '');
      weekdayCounts.set(dayNormalized, (weekdayCounts.get(dayNormalized) || 0) + 1);
    }
    
    // Progress
    if ((i + 1) % 5000 === 0 || i === entries.length - 1) {
      process.stdout.write(`\r   ${progressBar(i + 1, entries.length)}`);
    }
  }
  
  console.log('\n');
  
  // Sort catalog by score (highest first)
  catalog.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  
  // Initial stats before ARM enrichment
  let withImdb = catalog.filter(a => a.imdb_id).length;
  let imdbPercent = ((withImdb / catalog.length) * 100).toFixed(1);
  
  console.log('[INITIAL] Processing Results:');
  console.log(`   Total processed: ${catalog.length}`);
  console.log(`   With IMDB ID: ${withImdb} (${imdbPercent}%)`);
  console.log(`   Skipped (no MAL ID): ${skipped.noMalId}`);
  console.log(`   Skipped (bad type): ${skipped.badType}`);
  console.log(`   Skipped (bad status): ${skipped.badStatus}`);
  
  // === PHASE 2: ARM API Enrichment (optional, disabled by default) ===
  // ARM requires individual requests which is too slow for 22k+ entries
  // Enable with --arm flag for incremental updates
  const ENABLE_ARM = process.argv.includes('--arm');
  if (!TEST_MODE && imdbPercent < 50) {
    // Create a temporary catalog structure for ARM lookup
    const tempCatalog = catalog.map(a => ({ malId: a.malId }));
    const enrichedMappings = await enrichWithArmMappings(tempCatalog, imdbMappings, ENABLE_ARM);
    
    // Update catalog with new IMDB IDs if ARM was enabled
    if (ENABLE_ARM) {
      let newMappings = 0;
      for (const anime of catalog) {
        if (!anime.imdb_id && enrichedMappings.has(anime.malId)) {
          anime.imdb_id = enrichedMappings.get(anime.malId);
          newMappings++;
        }
      }
      console.log(`\n[ARM] Added ${newMappings} new IMDB mappings from ARM API`);
      
      // Update stats
      withImdb = catalog.filter(a => a.imdb_id).length;
      imdbPercent = ((withImdb / catalog.length) * 100).toFixed(1);
      
      // Cache the enriched mappings for future builds
      const cachePath = path.join(CONFIG.outputDir, 'imdb-mappings-cache.json');
      const cacheData = Object.fromEntries(enrichedMappings);
      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      console.log(`[CACHE] Saved ${enrichedMappings.size} mappings to cache`);
    }
  }
  
  console.log('\n[STATS] Final Results:');
  console.log(`   Total anime: ${catalog.length}`);
  console.log(`   With IMDB ID: ${withImdb} (${imdbPercent}%)`);
  console.log(`   Unique genres: ${genreCounts.size}`);
  console.log(`   Unique seasons: ${seasonCounts.size}`);
  console.log(`   Unique studios: ${studioCounts.size}`);
  console.log(`   Weekday data: ${weekdayCounts.size > 0 ? 'available' : 'not available'}`);
  
  // Build filter options
  console.log('\n[FILTERS] Building filter options...');
  
  // Sort genres by count (descending), then alphabetically
  const genreOptions = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([genre, count]) => `${genre} (${count})`);
  
  // Sort seasons by date (newest first)
  const seasonOptions = Array.from(seasonCounts.entries())
    .sort((a, b) => {
      const [yearA, seasonA] = a[0].split('-');
      const [yearB, seasonB] = b[0].split('-');
      if (yearA !== yearB) return parseInt(yearB) - parseInt(yearA);
      // Season order: winter > fall > summer > spring
      const seasonOrder = { winter: 4, fall: 3, summer: 2, spring: 1 };
      return (seasonOrder[seasonB] || 0) - (seasonOrder[seasonA] || 0);
    })
    .map(([season, count]) => {
      const [year, seasonName] = season.split('-');
      const display = `${year} - ${seasonName.charAt(0).toUpperCase() + seasonName.slice(1)}`;
      return `${display} (${count})`;
    });
  
  // Sort studios by count (descending)
  const studioOptions = Array.from(studioCounts.entries())
    .filter(([_, count]) => count >= 3) // Only studios with 3+ anime
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200) // Top 200 studios
    .map(([studio, count]) => `${studio} (${count})`);
  
  // Build weekday options in order (Monday to Sunday)
  const weekdayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const weekdayOptions = weekdayOrder
    .filter(day => weekdayCounts.has(day))
    .map(day => {
      const count = weekdayCounts.get(day) || 0;
      const displayName = day.charAt(0).toUpperCase() + day.slice(1);
      return `${displayName} (${count})`;
    });
  
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
    },
    weekdays: {
      withCounts: weekdayOptions,
      values: weekdayOrder.filter(day => weekdayCounts.has(day))
    }
  };
  
  // Build database object
  const database = {
    version: 1,
    buildDate: new Date().toISOString(),
    sourceDate: offlineDb.lastUpdate,
    stats: {
      totalAnime: catalog.length,
      withImdb,
      genres: genreCounts.size,
      seasons: seasonCounts.size,
      studios: studioCounts.size
    },
    catalog
  };
  
  // Write files
  console.log('\n[WRITE] Writing output files...');
  
  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  // Write uncompressed JSON (for debugging)
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
  console.log(`[DONE] Database build complete in ${formatDuration(duration)}`);
  console.log('============================================================');
}

// Run
buildDatabase().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
