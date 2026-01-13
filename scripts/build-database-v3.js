#!/usr/bin/env node
/**
 * AnimeStream Database Builder v3
 * 
 * Enhanced version that uses IMDB dataset title-matching to expand coverage
 * beyond Fribb/anime-lists mappings.
 * 
 * Sources:
 * 1. Kitsu API - Full anime catalog (21,000+ entries) with genres
 * 2. Fribb/anime-lists - Primary IMDB/TMDB/TVDB mappings (~7,100 IMDB)
 * 3. IMDB Datasets - Title-matching fallback for remaining anime
 * 
 * Strategy:
 * 1. Fetch all anime from Kitsu
 * 2. Apply Fribb mappings (MAL→IMDB, Kitsu→IMDB)
 * 3. For anime still without IMDB: use IMDB dataset title-matching
 * 4. Group seasons by shared IMDB ID
 * 5. Build final catalog with all anime that have IMDB IDs
 * 
 * Usage:
 *   node scripts/build-database-v3.js          # Full build
 *   node scripts/build-database-v3.js --test   # Test mode (500 items)
 *   node scripts/build-database-v3.js --skip-imdb  # Skip IMDB matching step
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

// CLI flags
const TEST_MODE = process.argv.includes('--test');
const SKIP_IMDB_MATCHING = process.argv.includes('--skip-imdb');
const TEST_LIMIT = 500;

// Configuration
const CONFIG = {
  outputDir: path.join(__dirname, '..', 'data'),
  imdbDir: path.join(__dirname, '..', 'data', 'imdb'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  catalogGzFile: TEST_MODE ? 'catalog-test.json.gz' : 'catalog.json.gz',
  filterOptionsFile: 'filter-options.json',
  
  // Kitsu API
  kitsuBaseUrl: 'https://kitsu.io/api/edge',
  kitsuPageSize: 20,
  
  // Fribb mappings
  fribbUrl: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  
  // Rate limiting
  requestDelay: 150,
  
  // IMDB matching settings
  minSimilarity: 0.85,
  yearTolerance: 2,
  minTitleLength: 3,
  relevantTypes: ['tvSeries', 'tvMiniSeries', 'movie', 'video', 'tvMovie', 'tvSpecial'],
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
// TITLE NORMALIZATION & MATCHING
// ============================================================

function normalizeTitle(title) {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .trim()
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[：・「」『』【】〈〉《》（）]/g, ' ')
    .replace(/[^\w\s\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf-]/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ou/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ii/g, 'i')
    .replace(/ee/g, 'e')
    .replace(/\s+(the\s+)?(animation|animated|anime|ova|ona|movie|film|special|tv|series)s?$/gi, '')
    .replace(/\s+(season|part|cour|chapter|arc)\s*\d*$/gi, '')
    .replace(/\s+(1st|2nd|3rd|\d+th)\s+(season|part|cour)$/gi, '')
    .replace(/\s+[ivx]+$/gi, '')
    .replace(/\s*s\d+\s*/gi, ' ')
    .replace(/\s*ep\.?\s*\d+/gi, '')
    .replace(/\band\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\ba\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, ' ')
    .trim();
}

function extractBaseTitle(title) {
  if (!title) return '';
  return title
    .replace(/:\s*(season|part|cour)\s*\d+/gi, '')
    .replace(/\s+(season|part|cour)\s*\d+/gi, '')
    .replace(/\s+\d+(st|nd|rd|th)\s+(season|part)/gi, '')
    .replace(/\s+[IVX]+$/gi, '')
    .replace(/\s+\d+$/g, '')
    .replace(/:\s*[^:]+$/g, '')
    .trim();
}

function generateTitleVariations(title, originalTitle) {
  const variations = new Set();
  
  if (title) {
    variations.add(normalizeTitle(title));
    variations.add(normalizeTitle(extractBaseTitle(title)));
  }
  
  if (originalTitle && originalTitle !== title) {
    variations.add(normalizeTitle(originalTitle));
    variations.add(normalizeTitle(extractBaseTitle(originalTitle)));
  }
  
  if (title) {
    const noThe = title.replace(/^the\s+/i, '');
    if (noThe !== title) variations.add(normalizeTitle(noThe));
  }
  
  return [...variations].filter(v => v.length >= CONFIG.minTitleLength);
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  
  return matrix[b.length][a.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  
  if (longer.length === 0) return 1;
  if (shorter.length < longer.length * 0.5) return 0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
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
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function fetchAllKitsuAnime() {
  console.log('\n📥 Fetching anime from Kitsu API (with genres)...');
  console.log('   Total available: ~21,859 anime\n');
  
  const allAnime = [];
  const genreMap = new Map();
  let offset = 0;
  let totalCount = null;
  
  while (true) {
    try {
      const data = await kitsuRequest(
        `/anime?page[limit]=${CONFIG.kitsuPageSize}&page[offset]=${offset}&sort=-userCount&include=genres`
      );
      
      if (totalCount === null) {
        totalCount = TEST_MODE ? Math.min(data.meta.count, TEST_LIMIT) : data.meta.count;
      }
      
      if (data.included) {
        for (const item of data.included) {
          if (item.type === 'genres') {
            genreMap.set(item.id, item.attributes.name);
          }
        }
      }
      
      for (const anime of data.data) {
        const genreIds = anime.relationships?.genres?.data?.map(g => g.id) || [];
        anime._genres = genreIds.map(id => genreMap.get(id)).filter(Boolean);
        allAnime.push(anime);
      }
      
      const progress = Math.min(allAnime.length, totalCount);
      process.stdout.write(`\r   ${progressBar(progress, totalCount)} - ${allAnime.length} fetched`);
      
      if (!data.links.next || allAnime.length >= totalCount) break;
      
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
// FRIBB MAPPINGS
// ============================================================

async function loadFribbMappings() {
  console.log('📥 Loading Fribb/anime-lists mappings...');
  
  const fetch = (await import('node-fetch')).default;
  
  try {
    const response = await fetch(CONFIG.fribbUrl, { timeout: 60000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const mappings = await response.json();
    
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
// IMDB DATASET LOADING & MATCHING
// ============================================================

async function loadImdbBasics(filePath) {
  console.log('\n📖 Loading IMDB basics (filtering to animation)...');
  
  const imdbData = new Map();
  let lineCount = 0;
  let animationCount = 0;
  
  const gunzip = zlib.createGunzip();
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity
  });
  
  let headers = null;
  
  for await (const line of rl) {
    lineCount++;
    
    if (lineCount === 1) {
      headers = line.split('\t');
      continue;
    }
    
    if (lineCount % 500000 === 0) {
      process.stdout.write(`\r   Processed ${(lineCount / 1000000).toFixed(1)}M lines, found ${animationCount} animation titles`);
    }
    
    const values = line.split('\t');
    const row = {};
    headers.forEach((h, i) => row[h] = values[i]);
    
    const genres = row.genres || '';
    const titleType = row.titleType || '';
    const isAdult = row.isAdult === '1';
    
    if (!CONFIG.relevantTypes.includes(titleType)) continue;
    if (!genres.toLowerCase().includes('animation')) continue;
    if (isAdult) continue;
    
    imdbData.set(row.tconst, {
      id: row.tconst,
      title: row.primaryTitle,
      originalTitle: row.originalTitle !== '\\N' ? row.originalTitle : null,
      year: row.startYear !== '\\N' ? parseInt(row.startYear) : null,
      type: titleType,
      genres: genres.split(','),
    });
    
    animationCount++;
  }
  
  console.log(`\n   ✅ Loaded ${animationCount} animation titles`);
  return imdbData;
}

async function loadImdbAkas(filePath, relevantIds) {
  console.log('\n📖 Loading IMDB alternative titles...');
  
  const akasMap = new Map();
  let lineCount = 0;
  
  const gunzip = zlib.createGunzip();
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity
  });
  
  let headers = null;
  
  for await (const line of rl) {
    lineCount++;
    
    if (lineCount === 1) {
      headers = line.split('\t');
      continue;
    }
    
    if (lineCount % 1000000 === 0) {
      process.stdout.write(`\r   Processed ${(lineCount / 1000000).toFixed(1)}M lines`);
    }
    
    const values = line.split('\t');
    const titleId = values[0];
    
    if (!relevantIds.has(titleId)) continue;
    
    const title = values[2];
    
    if (title && title !== '\\N') {
      if (!akasMap.has(titleId)) {
        akasMap.set(titleId, new Set());
      }
      akasMap.get(titleId).add(title);
    }
  }
  
  console.log(`\n   ✅ Loaded alternative titles for ${akasMap.size} entries`);
  return akasMap;
}

function buildSearchIndex(imdbData, akasMap) {
  console.log('\n🔧 Building IMDB search index...');
  
  const index = new Map();
  
  for (const [imdbId, entry] of imdbData) {
    const normalized = normalizeTitle(entry.title);
    if (normalized.length >= CONFIG.minTitleLength) {
      if (!index.has(normalized)) index.set(normalized, []);
      index.get(normalized).push(entry);
    }
    
    if (entry.originalTitle) {
      const normOriginal = normalizeTitle(entry.originalTitle);
      if (normOriginal.length >= CONFIG.minTitleLength && normOriginal !== normalized) {
        if (!index.has(normOriginal)) index.set(normOriginal, []);
        index.get(normOriginal).push(entry);
      }
    }
    
    const akas = akasMap.get(imdbId);
    if (akas) {
      for (const aka of akas) {
        const normAka = normalizeTitle(aka);
        if (normAka.length >= CONFIG.minTitleLength) {
          if (!index.has(normAka)) index.set(normAka, []);
          if (!index.get(normAka).some(e => e.id === imdbId)) {
            index.get(normAka).push(entry);
          }
        }
      }
    }
  }
  
  console.log(`   ✅ Indexed ${index.size} unique title variations`);
  return index;
}

function findImdbMatch(name, year, searchIndex) {
  const variations = generateTitleVariations(name, null);
  
  let bestMatch = null;
  let bestScore = 0;
  
  // Exact match
  for (const variation of variations) {
    if (searchIndex.has(variation)) {
      const candidates = searchIndex.get(variation);
      
      for (const candidate of candidates) {
        if (year && candidate.year) {
          const yearDiff = Math.abs(year - candidate.year);
          if (yearDiff > CONFIG.yearTolerance) continue;
        }
        
        return { imdbId: candidate.id, score: 1.0, reason: 'exact' };
      }
    }
  }
  
  // Fuzzy match
  for (const [indexTitle, candidates] of searchIndex) {
    for (const variation of variations) {
      const simScore = similarity(variation, indexTitle);
      
      if (simScore >= CONFIG.minSimilarity && simScore > bestScore) {
        for (const candidate of candidates) {
          if (year && candidate.year) {
            const yearDiff = Math.abs(year - candidate.year);
            if (yearDiff > CONFIG.yearTolerance) continue;
          }
          
          let typeBonus = 0;
          if (candidate.type === 'tvSeries' || candidate.type === 'tvMiniSeries') {
            typeBonus = 0.02;
          }
          
          const adjustedScore = simScore + typeBonus;
          if (adjustedScore > bestScore) {
            bestMatch = candidate;
            bestScore = adjustedScore;
          }
        }
      }
    }
  }
  
  if (bestMatch && bestScore >= CONFIG.minSimilarity) {
    return { imdbId: bestMatch.id, score: bestScore, reason: 'fuzzy' };
  }
  
  return null;
}

// ============================================================
// SEASON GROUPING
// ============================================================

function extractCleanTitle(title) {
  if (!title) return '';
  
  return title
    .replace(/:\s*(?:Season|Part|Cour)\s*\d+/gi, '')
    .replace(/:\s*The\s+Final\s+Season/gi, '')
    .replace(/:\s*Final\s+Season/gi, '')
    .replace(/\s+(?:Season|Part|Cour)\s*\d+/gi, '')
    .replace(/\s+\d+(?:st|nd|rd|th)\s+Season/gi, '')
    .replace(/\s+[IVX]+$/gi, '')
    .replace(/\s+\d+$/gi, '')
    .trim();
}

function groupByImdbId(animeList) {
  console.log('\n🔗 Grouping seasons by IMDB ID...');
  
  const groups = new Map();
  
  for (const anime of animeList) {
    const imdbId = anime.imdb_id;
    if (!imdbId) continue;
    
    if (!groups.has(imdbId)) {
      groups.set(imdbId, []);
    }
    groups.get(imdbId).push(anime);
  }
  
  const result = [];
  let mergedCount = 0;
  
  for (const [imdbId, entries] of groups) {
    if (entries.length === 1) {
      const entry = entries[0];
      entry.name = extractCleanTitle(entry.name) || entry.name;
      result.push(entry);
    } else {
      mergedCount += entries.length - 1;
      
      entries.sort((a, b) => {
        if (a.year && b.year && a.year !== b.year) {
          return a.year - b.year;
        }
        return (b.popularity || 0) - (a.popularity || 0);
      });
      
      const primary = entries[0];
      primary.name = extractCleanTitle(primary.name) || primary.name;
      
      const allGenres = new Set(primary.genres || []);
      for (const entry of entries) {
        if (entry.genres) {
          entry.genres.forEach(g => allGenres.add(g));
        }
      }
      primary.genres = [...allGenres];
      
      const ratings = entries.map(e => e.rating).filter(r => r != null);
      if (ratings.length > 0) {
        primary.rating = Math.max(...ratings);
      }
      
      primary.popularity = entries.reduce((sum, e) => sum + (e.popularity || 0), 0);
      primary._mergedSeasons = entries.length;
      
      result.push(primary);
    }
  }
  
  console.log(`   ✅ Grouped ${animeList.length} → ${result.length} entries (merged ${mergedCount} seasons)\n`);
  return result;
}

// ============================================================
// CONVERT TO STREMIO FORMAT
// ============================================================

function convertToStremioMeta(kitsuAnime, imdbId, malId) {
  const attrs = kitsuAnime.attributes;
  
  const titles = attrs.titles || {};
  const name = titles.en || titles.en_jp || attrs.canonicalTitle || 'Unknown';
  
  const poster = attrs.posterImage?.large || attrs.posterImage?.medium || null;
  const background = attrs.coverImage?.large || attrs.coverImage?.original || null;
  const rating = attrs.averageRating ? parseFloat(attrs.averageRating) / 10 : null;
  const year = attrs.startDate ? parseInt(attrs.startDate.split('-')[0], 10) : null;
  
  let season = null;
  if (attrs.startDate) {
    const month = parseInt(attrs.startDate.split('-')[1], 10);
    if (month >= 1 && month <= 3) season = 'winter';
    else if (month >= 4 && month <= 6) season = 'spring';
    else if (month >= 7 && month <= 9) season = 'summer';
    else if (month >= 10 && month <= 12) season = 'fall';
  }
  
  let status = attrs.status;
  if (status === 'finished') status = 'FINISHED';
  else if (status === 'current') status = 'ONGOING';
  else if (status === 'upcoming') status = 'UPCOMING';
  
  return {
    id: imdbId,
    imdb_id: imdbId,
    kitsu_id: parseInt(kitsuAnime.id, 10),
    mal_id: malId,
    type: 'series',
    name: name,
    slug: attrs.slug,
    description: attrs.synopsis || attrs.description || '',
    year: year,
    season: season,
    status: status,
    rating: rating,
    poster: poster,
    background: background,
    genres: kitsuAnime._genres || [],
    episodeCount: attrs.episodeCount || null,
    runtime: attrs.episodeLength ? `${attrs.episodeLength} min` : null,
    ageRating: attrs.ageRating,
    subtype: attrs.subtype,
    popularity: attrs.userCount || 0,
  };
}

// ============================================================
// MAIN BUILD FUNCTION
// ============================================================

async function buildDatabase() {
  const startTime = Date.now();
  
  console.log('\n============================================================');
  console.log('       AnimeStream Database Builder v3');
  console.log('       (with IMDB Dataset Title-Matching)');
  console.log('============================================================');
  console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'FULL'}`);
  console.log(`IMDB Matching: ${SKIP_IMDB_MATCHING ? 'DISABLED' : 'ENABLED'}`);
  console.log(`Output: ${CONFIG.outputDir}\n`);
  
  // Step 1: Load Fribb mappings
  const { malToImdb, malToTmdb, kitsuToImdb } = await loadFribbMappings();
  
  // Step 2: Load IMDB data if not skipping
  let searchIndex = null;
  if (!SKIP_IMDB_MATCHING) {
    const basicsPath = path.join(CONFIG.imdbDir, 'title.basics.tsv.gz');
    const akasPath = path.join(CONFIG.imdbDir, 'title.akas.tsv.gz');
    
    if (fs.existsSync(basicsPath) && fs.existsSync(akasPath)) {
      const imdbData = await loadImdbBasics(basicsPath);
      const akasMap = await loadImdbAkas(akasPath, imdbData);
      searchIndex = buildSearchIndex(imdbData, akasMap);
    } else {
      console.log('\n⚠️  IMDB datasets not found. Run with --skip-imdb or download first.');
      console.log('   Run: node scripts/enrich-imdb-mappings.js --download\n');
    }
  }
  
  // Step 3: Fetch all anime from Kitsu
  const kitsuAnime = await fetchAllKitsuAnime();
  
  // Step 4: Process anime - apply mappings and IMDB matching
  console.log('🔄 Processing anime...\n');
  
  const processedAnime = [];
  let fromFribb = 0;
  let fromImdbMatch = 0;
  let noMatch = 0;
  
  const batchSize = 10;
  for (let i = 0; i < kitsuAnime.length; i += batchSize) {
    const batch = kitsuAnime.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (anime) => {
      const kitsuId = parseInt(anime.id, 10);
      const attrs = anime.attributes;
      const titles = attrs.titles || {};
      const name = titles.en || titles.en_jp || attrs.canonicalTitle || 'Unknown';
      const year = attrs.startDate ? parseInt(attrs.startDate.split('-')[0], 10) : null;
      
      // Try Fribb mapping first
      let imdbId = kitsuToImdb.get(kitsuId);
      let malId = null;
      let matchSource = 'fribb_kitsu';
      
      if (!imdbId) {
        const mappings = await fetchKitsuMappings(kitsuId);
        malId = mappings.mal_id;
        
        if (malId && malToImdb.has(malId)) {
          imdbId = malToImdb.get(malId);
          matchSource = 'fribb_mal';
        }
      }
      
      // If still no IMDB, try title matching
      if (!imdbId && searchIndex) {
        const match = findImdbMatch(name, year, searchIndex);
        if (match) {
          imdbId = match.imdbId;
          matchSource = `imdb_${match.reason}`;
        }
      }
      
      // Track source
      if (imdbId) {
        if (matchSource.startsWith('fribb')) {
          fromFribb++;
        } else {
          fromImdbMatch++;
        }
        
        const meta = convertToStremioMeta(anime, imdbId, malId);
        meta._matchSource = matchSource;
        processedAnime.push(meta);
      } else {
        noMatch++;
      }
    }));
    
    const processed = Math.min(i + batchSize, kitsuAnime.length);
    process.stdout.write(`\r   ${progressBar(processed, kitsuAnime.length)} - Fribb: ${fromFribb}, IMDB: ${fromImdbMatch}, None: ${noMatch}`);
    
    await sleep(CONFIG.requestDelay);
  }
  
  console.log(`\n\n   📊 Mapping Results:`);
  console.log(`      From Fribb: ${fromFribb}`);
  console.log(`      From IMDB matching: ${fromImdbMatch}`);
  console.log(`      No IMDB found: ${noMatch}\n`);
  
  // Step 5: Group by IMDB ID
  const groupedAnime = groupByImdbId(processedAnime);
  
  // Step 6: Sort by popularity
  groupedAnime.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  
  // Step 7: Build filter options
  console.log('📋 Building filter options...');
  const genreCounts = new Map();
  const yearCounts = new Map();
  const statusCounts = new Map();
  const seasonCounts = new Map();
  const weekdayCounts = new Map();
  
  for (const anime of groupedAnime) {
    if (anime.genres && anime.genres.length > 0) {
      for (const genre of anime.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }
    if (anime.year) {
      yearCounts.set(anime.year, (yearCounts.get(anime.year) || 0) + 1);
    }
    if (anime.status) {
      statusCounts.set(anime.status, (statusCounts.get(anime.status) || 0) + 1);
    }
    if (anime.year && anime.season) {
      const seasonName = anime.season.charAt(0).toUpperCase() + anime.season.slice(1).toLowerCase();
      const seasonKey = `${anime.year} - ${seasonName}`;
      seasonCounts.set(seasonKey, (seasonCounts.get(seasonKey) || 0) + 1);
    }
    if (anime.status === 'ONGOING' && anime.broadcastDay) {
      const day = anime.broadcastDay.charAt(0).toUpperCase() + anime.broadcastDay.slice(1).toLowerCase();
      weekdayCounts.set(day, (weekdayCounts.get(day) || 0) + 1);
    }
  }
  
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
  
  console.log(`   ✅ ${filterOptions.genres.list.length} genres, ${filterOptions.seasons.list.length} seasons\n`);
  
  // Step 8: Write output files
  console.log('💾 Writing output files...');
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  const catalog = {
    buildDate: new Date().toISOString(),
    version: '3.0',
    source: 'kitsu+fribb+imdb',
    stats: {
      totalAnime: groupedAnime.length,
      fromFribb: fromFribb,
      fromImdbMatch: fromImdbMatch,
      noMatch: noMatch,
    },
    catalog: groupedAnime
  };
  
  const jsonPath = path.join(CONFIG.outputDir, CONFIG.catalogFile);
  const jsonContent = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(jsonPath, jsonContent);
  console.log(`   📄 ${CONFIG.catalogFile}: ${formatSize(jsonContent.length)}`);
  
  const gzPath = path.join(CONFIG.outputDir, CONFIG.catalogGzFile);
  const compressed = zlib.gzipSync(jsonContent);
  fs.writeFileSync(gzPath, compressed);
  const compressionRatio = Math.round((1 - compressed.length / jsonContent.length) * 100);
  console.log(`   📦 ${CONFIG.catalogGzFile}: ${formatSize(compressed.length)} (${compressionRatio}% compression)`);
  
  const filterPath = path.join(CONFIG.outputDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   📋 ${CONFIG.filterOptionsFile}: ${formatSize(fs.statSync(filterPath).size)}`);
  
  // Summary
  const duration = Date.now() - startTime;
  console.log('\n============================================================');
  console.log(`✅ Database build complete in ${formatDuration(duration)}`);
  console.log('============================================================');
  console.log(`   Total anime: ${groupedAnime.length}`);
  console.log(`   From Fribb mappings: ${fromFribb}`);
  console.log(`   From IMDB title-match: ${fromImdbMatch}`);
  console.log(`   Excluded (no IMDB): ${noMatch}`);
  console.log(`   All entries have IMDB IDs for stream matching!`);
  console.log('============================================================\n');
}

// Run
buildDatabase().catch(err => {
  console.error('\n❌ Build failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
