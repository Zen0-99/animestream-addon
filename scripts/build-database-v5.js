#!/usr/bin/env node
/**
 * AnimeStream Database Builder v5
 * 
 * Enhanced IMDB matching with multi-gate scoring system.
 * 
 * Improvements over v4:
 * - Multi-gate scoring: Title (40pts) + Year (20pts) + Type (15pts) + Runtime (10pts) + Genres (15pts)
 * - Confidence thresholds: ≥80pts auto-accept, 60-79pts flag for review, <60pts reject
 * - Leverages anime-offline-database.json synonyms for better title matching
 * - Detailed match reporting with rejection reasons
 * 
 * Usage:
 *   node scripts/build-database-v5.js          # Full build
 *   node scripts/build-database-v5.js --test   # Test mode (500 items)
 *   node scripts/build-database-v5.js --skip-cinemeta  # Skip Cinemeta enrichment
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const https = require('https');

// CLI flags
const TEST_MODE = process.argv.includes('--test');
const SKIP_CINEMETA = process.argv.includes('--skip-cinemeta');
const VERBOSE = process.argv.includes('--verbose');
const TEST_LIMIT = 500;

// Configuration
const CONFIG = {
  outputDir: path.join(__dirname, '..', 'data'),
  imdbDir: path.join(__dirname, '..', 'data', 'imdb'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  filterOptionsFile: 'filter-options.json',
  matchReportFile: 'imdb-match-report.json',
  
  // Kitsu API
  kitsuBaseUrl: 'https://kitsu.io/api/edge',
  kitsuPageSize: 20,
  
  // Fribb mappings
  fribbUrl: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  
  // Anime Offline Database (for synonyms)
  animeOfflineDbUrl: 'https://raw.githubusercontent.com/manami-project/anime-offline-database/master/anime-offline-database-minified.json',
  
  // Cinemeta
  cinemataBase: 'https://v3-cinemeta.strem.io/meta',
  cinemataDelayMs: 50,
  cinemataBatchSize: 5,
  
  // Rate limiting
  requestDelay: 150,
  
  // V5 Multi-Gate Scoring Thresholds
  scoring: {
    // Gate weights (total = 100)
    titleMaxPoints: 40,
    yearMaxPoints: 20,
    typeMaxPoints: 15,
    runtimeMaxPoints: 10,
    genreMaxPoints: 15,
    
    // Confidence thresholds
    highConfidence: 80,    // Auto-accept
    mediumConfidence: 60,  // Flag for review
    // Below 60 = reject
    
    // Title similarity thresholds
    exactTitlePoints: 40,
    title95Points: 35,
    title90Points: 30,
    title85Points: 25,
    title80Points: 20,
    minTitleSimilarity: 0.80,
    
    // Year tolerance
    yearExactPoints: 20,
    year1Points: 15,
    year2Points: 10,
    year3Points: 5,
    
    // Runtime tolerance (minutes)
    runtimeExact5Points: 10,
    runtimeWithin10Points: 5,
    
    // Genre matching
    genrePointsEach: 3,
  },
  
  // Type mapping (Kitsu subtype → IMDB titleType)
  typeMapping: {
    'TV': ['tvSeries', 'tvMiniSeries'],
    'movie': ['movie', 'tvMovie'],
    'OVA': ['video', 'tvSpecial'],
    'ONA': ['tvSeries', 'video'],
    'special': ['tvSpecial', 'video'],
    'music': ['musicVideo', 'video'],
  },
  
  // Genre normalization (Kitsu → IMDB common terms)
  genreMapping: {
    'action': ['action'],
    'adventure': ['adventure'],
    'comedy': ['comedy'],
    'drama': ['drama'],
    'fantasy': ['fantasy'],
    'horror': ['horror'],
    'mystery': ['mystery'],
    'romance': ['romance'],
    'sci-fi': ['sci-fi', 'science fiction'],
    'slice of life': ['drama'],
    'sports': ['sport'],
    'supernatural': ['fantasy', 'horror'],
    'thriller': ['thriller'],
    'animation': ['animation'],
  },
};

// Statistics tracking
const stats = {
  totalKitsu: 0,
  matchedFribb: 0,
  matchedImdbHigh: 0,
  matchedImdbMedium: 0,
  matchedImdbLow: 0,
  noMatch: 0,
  cinemataEnriched: 0,
  cinemataLogos: 0,
  cinemataBackgrounds: 0,
  cinemataCast: 0,
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
    .replace(/[''`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[：:]/g, ': ')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s'-]/g, '')
    .trim();
}

function generateTitleVariations(title, synonyms = []) {
  const variations = new Set();
  
  // Primary title and normalized
  const normalized = normalizeTitle(title);
  variations.add(normalized);
  
  // Without spaces
  variations.add(normalized.replace(/\s+/g, ''));
  
  // Add all synonyms
  if (synonyms && Array.isArray(synonyms)) {
    for (const syn of synonyms) {
      if (syn && typeof syn === 'string') {
        const normSyn = normalizeTitle(syn);
        if (normSyn.length >= 3) {
          variations.add(normSyn);
          variations.add(normSyn.replace(/\s+/g, ''));
        }
      }
    }
  }
  
  // Season/sequel variations
  const cleanTitle = normalized
    .replace(/\s*:\s*season\s*\d+/gi, '')
    .replace(/\s*season\s*\d+/gi, '')
    .replace(/\s*\d+(st|nd|rd|th)\s*season/gi, '')
    .replace(/\s*part\s*\d+/gi, '')
    .replace(/\s*[ivx]+$/gi, '')
    .replace(/\s*2nd$/gi, '')
    .replace(/\s*the\s*final\s*season/gi, '')
    .trim();
  
  if (cleanTitle !== normalized && cleanTitle.length >= 3) {
    variations.add(cleanTitle);
  }
  
  return Array.from(variations);
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
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
  if (shorter.length < longer.length * 0.4) return 0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

// ============================================================
// V5 MULTI-GATE SCORING SYSTEM
// ============================================================

/**
 * Calculate title score (max 40 points)
 */
function scoreTitleMatch(animeVariations, imdbTitle, imdbAkas = []) {
  let bestSimilarity = 0;
  
  // Build list of IMDB titles to match against
  const imdbTitles = [normalizeTitle(imdbTitle)];
  if (imdbAkas && Array.isArray(imdbAkas)) {
    for (const aka of imdbAkas) {
      const normAka = normalizeTitle(aka);
      if (normAka.length >= 3) {
        imdbTitles.push(normAka);
      }
    }
  }
  
  // Find best match across all variations
  for (const animeTitle of animeVariations) {
    for (const imdbT of imdbTitles) {
      // Exact match
      if (animeTitle === imdbT) {
        return { score: CONFIG.scoring.exactTitlePoints, similarity: 1.0, matched: imdbT };
      }
      
      const sim = similarity(animeTitle, imdbT);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
      }
    }
  }
  
  // Score based on similarity
  if (bestSimilarity >= 0.95) return { score: CONFIG.scoring.title95Points, similarity: bestSimilarity };
  if (bestSimilarity >= 0.90) return { score: CONFIG.scoring.title90Points, similarity: bestSimilarity };
  if (bestSimilarity >= 0.85) return { score: CONFIG.scoring.title85Points, similarity: bestSimilarity };
  if (bestSimilarity >= 0.80) return { score: CONFIG.scoring.title80Points, similarity: bestSimilarity };
  
  return { score: 0, similarity: bestSimilarity };
}

/**
 * Calculate year score (max 20 points)
 */
function scoreYearMatch(animeYear, imdbYear) {
  if (!animeYear || !imdbYear) return { score: 5, diff: null }; // Partial credit if unknown
  
  const diff = Math.abs(animeYear - imdbYear);
  
  if (diff === 0) return { score: CONFIG.scoring.yearExactPoints, diff: 0 };
  if (diff === 1) return { score: CONFIG.scoring.year1Points, diff: 1 };
  if (diff === 2) return { score: CONFIG.scoring.year2Points, diff: 2 };
  if (diff === 3) return { score: CONFIG.scoring.year3Points, diff: 3 };
  
  return { score: 0, diff };
}

/**
 * Calculate type score (max 15 points)
 */
function scoreTypeMatch(animeSubtype, imdbType) {
  if (!animeSubtype || !imdbType) return { score: 5, matched: false }; // Partial credit
  
  const subtypeUpper = animeSubtype.toUpperCase();
  const expectedTypes = CONFIG.typeMapping[subtypeUpper] || CONFIG.typeMapping[animeSubtype] || [];
  
  if (expectedTypes.includes(imdbType)) {
    return { score: CONFIG.scoring.typeMaxPoints, matched: true };
  }
  
  // Partial credit for close matches
  if (imdbType === 'tvSeries' || imdbType === 'tvMiniSeries') {
    return { score: 8, matched: false }; // Most anime are TV, give partial credit
  }
  
  return { score: 0, matched: false };
}

/**
 * Calculate runtime score (max 10 points)
 */
function scoreRuntimeMatch(animeRuntime, imdbRuntime) {
  if (!animeRuntime || !imdbRuntime) return { score: 3, diff: null }; // Partial credit
  
  // Parse runtime strings like "24 min" or "24"
  const animeMin = parseInt(String(animeRuntime).replace(/\D/g, '')) || 0;
  const imdbMin = parseInt(String(imdbRuntime).replace(/\D/g, '')) || 0;
  
  if (animeMin === 0 || imdbMin === 0) return { score: 3, diff: null };
  
  const diff = Math.abs(animeMin - imdbMin);
  
  if (diff <= 5) return { score: CONFIG.scoring.runtimeExact5Points, diff };
  if (diff <= 10) return { score: CONFIG.scoring.runtimeWithin10Points, diff };
  
  return { score: 0, diff };
}

/**
 * Calculate genre score (max 15 points)
 */
function scoreGenreMatch(animeGenres, imdbGenres) {
  if (!animeGenres || !imdbGenres) return { score: 5, matches: [] }; // Partial credit
  if (!Array.isArray(animeGenres) || !Array.isArray(imdbGenres)) return { score: 5, matches: [] };
  
  // Normalize genres
  const normalizedAnime = animeGenres.map(g => g.toLowerCase().trim());
  const normalizedImdb = imdbGenres.map(g => g.toLowerCase().trim());
  
  const matches = [];
  
  for (const animeGenre of normalizedAnime) {
    // Direct match
    if (normalizedImdb.includes(animeGenre)) {
      matches.push(animeGenre);
      continue;
    }
    
    // Check mapped equivalents
    const mappedGenres = CONFIG.genreMapping[animeGenre] || [];
    for (const mapped of mappedGenres) {
      if (normalizedImdb.includes(mapped)) {
        matches.push(animeGenre);
        break;
      }
    }
  }
  
  // Animation genre is expected for anime
  if (normalizedImdb.includes('animation') && !matches.includes('animation')) {
    matches.push('animation');
  }
  
  const score = Math.min(matches.length * CONFIG.scoring.genrePointsEach, CONFIG.scoring.genreMaxPoints);
  return { score, matches };
}

/**
 * Calculate total match score with breakdown
 */
function calculateMatchScore(anime, imdbCandidate, synonyms = []) {
  const variations = generateTitleVariations(anime.name, synonyms);
  
  const titleResult = scoreTitleMatch(variations, imdbCandidate.title, imdbCandidate.akas);
  const yearResult = scoreYearMatch(anime.year, imdbCandidate.year);
  const typeResult = scoreTypeMatch(anime.subtype, imdbCandidate.type);
  const runtimeResult = scoreRuntimeMatch(anime.runtime, imdbCandidate.runtime);
  const genreResult = scoreGenreMatch(anime.genres, imdbCandidate.genres);
  
  const totalScore = titleResult.score + yearResult.score + typeResult.score + 
                     runtimeResult.score + genreResult.score;
  
  return {
    totalScore,
    breakdown: {
      title: { ...titleResult, max: CONFIG.scoring.titleMaxPoints },
      year: { ...yearResult, max: CONFIG.scoring.yearMaxPoints },
      type: { ...typeResult, max: CONFIG.scoring.typeMaxPoints },
      runtime: { ...runtimeResult, max: CONFIG.scoring.runtimeMaxPoints },
      genre: { ...genreResult, max: CONFIG.scoring.genreMaxPoints },
    },
    confidence: totalScore >= CONFIG.scoring.highConfidence ? 'high' :
                totalScore >= CONFIG.scoring.mediumConfidence ? 'medium' : 'low',
  };
}

// ============================================================
// HTTP HELPERS
// ============================================================

async function fetchWithRetry(url, options = {}, retries = 3) {
  const fetch = (await import('node-fetch')).default;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', ...options.headers },
        timeout: options.timeout || 30000
      });
      
      if (response.status === 429) {
        console.log('\n   ⚠️  Rate limited, waiting 30s...');
        await sleep(30000);
        continue;
      }
      
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      return await response.json();
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(1000 * attempt);
    }
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    const request = (followUrl) => {
      https.get(followUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    
    request(url);
  });
}

// ============================================================
// IMDB DATA LOADING
// ============================================================

async function loadImdbData() {
  console.log('\n📊 Loading IMDB datasets...');
  
  const basicsFile = path.join(CONFIG.imdbDir, 'title.basics.tsv.gz');
  const akasFile = path.join(CONFIG.imdbDir, 'title.akas.tsv.gz');
  
  // Check if files exist, download if not
  if (!fs.existsSync(basicsFile)) {
    console.log('   Downloading title.basics.tsv.gz...');
    await downloadFile('https://datasets.imdbws.com/title.basics.tsv.gz', basicsFile);
  }
  
  if (!fs.existsSync(akasFile)) {
    console.log('   Downloading title.akas.tsv.gz...');
    await downloadFile('https://datasets.imdbws.com/title.akas.tsv.gz', akasFile);
  }
  
  // Load basics (filter to Animation genre only)
  console.log('   Loading title.basics.tsv.gz (filtering Animation)...');
  const imdbTitles = new Map();
  
  const basicsStream = fs.createReadStream(basicsFile).pipe(zlib.createGunzip());
  const basicsReader = readline.createInterface({ input: basicsStream });
  
  let basicsCount = 0;
  let animationCount = 0;
  
  for await (const line of basicsReader) {
    basicsCount++;
    if (basicsCount === 1) continue; // Skip header
    
    const parts = line.split('\t');
    const [tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtimeMinutes, genres] = parts;
    
    // Filter to Animation genre and relevant types
    if (!genres || !genres.toLowerCase().includes('animation')) continue;
    if (!CONFIG.typeMapping.TV.includes(titleType) && 
        !CONFIG.typeMapping.movie.includes(titleType) &&
        !CONFIG.typeMapping.OVA.includes(titleType)) continue;
    if (isAdult === '1') continue;
    
    animationCount++;
    imdbTitles.set(tconst, {
      id: tconst,
      title: primaryTitle,
      originalTitle: originalTitle !== '\\N' ? originalTitle : null,
      type: titleType,
      year: startYear !== '\\N' ? parseInt(startYear) : null,
      runtime: runtimeMinutes !== '\\N' ? parseInt(runtimeMinutes) : null,
      genres: genres !== '\\N' ? genres.split(',').map(g => g.trim()) : [],
      akas: [],
    });
  }
  
  console.log(`   Loaded ${animationCount.toLocaleString()} Animation titles from ${basicsCount.toLocaleString()} total`);
  
  // Load alternative titles (akas)
  console.log('   Loading title.akas.tsv.gz...');
  const akasStream = fs.createReadStream(akasFile).pipe(zlib.createGunzip());
  const akasReader = readline.createInterface({ input: akasStream });
  
  let akasCount = 0;
  let akasAdded = 0;
  
  for await (const line of akasReader) {
    akasCount++;
    if (akasCount === 1) continue; // Skip header
    
    const parts = line.split('\t');
    const [titleId, ordering, title] = parts;
    
    if (imdbTitles.has(titleId)) {
      const entry = imdbTitles.get(titleId);
      if (title && title !== entry.title && title !== '\\N') {
        entry.akas.push(title);
        akasAdded++;
      }
    }
  }
  
  console.log(`   Added ${akasAdded.toLocaleString()} alternative titles`);
  
  // Build search index
  console.log('   Building search index...');
  const searchIndex = new Map();
  
  for (const [id, entry] of imdbTitles) {
    const titles = [entry.title, entry.originalTitle, ...entry.akas].filter(Boolean);
    
    for (const title of titles) {
      const normalized = normalizeTitle(title);
      if (normalized.length < 3) continue;
      
      if (!searchIndex.has(normalized)) {
        searchIndex.set(normalized, []);
      }
      searchIndex.get(normalized).push(entry);
    }
  }
  
  console.log(`   Search index: ${searchIndex.size.toLocaleString()} unique titles`);
  
  return { imdbTitles, searchIndex };
}

// ============================================================
// FRIBB MAPPINGS
// ============================================================

async function loadFribbMappings() {
  console.log('\n🗺️  Loading Fribb mappings...');
  
  const data = await fetchWithRetry(CONFIG.fribbUrl);
  
  const malToImdb = new Map();
  const kitsuToImdb = new Map();
  const anilistToImdb = new Map();
  
  for (const entry of data) {
    const imdbId = entry.imdb_id;
    if (!imdbId) continue;
    
    if (entry.mal_id) malToImdb.set(entry.mal_id, imdbId);
    if (entry.kitsu_id) kitsuToImdb.set(entry.kitsu_id, imdbId);
    if (entry.anilist_id) anilistToImdb.set(entry.anilist_id, imdbId);
  }
  
  console.log(`   MAL→IMDB: ${malToImdb.size.toLocaleString()} mappings`);
  console.log(`   Kitsu→IMDB: ${kitsuToImdb.size.toLocaleString()} mappings`);
  console.log(`   AniList→IMDB: ${anilistToImdb.size.toLocaleString()} mappings`);
  
  return { malToImdb, kitsuToImdb, anilistToImdb };
}

// ============================================================
// ANIME OFFLINE DATABASE (SYNONYMS)
// ============================================================

async function loadAnimeOfflineDatabase() {
  console.log('\n📚 Loading Anime Offline Database (for synonyms)...');
  
  const localPath = path.join(CONFIG.outputDir, 'anime-offline-database.json');
  
  let data;
  
  // Try local file first
  if (fs.existsSync(localPath)) {
    console.log('   Using local file...');
    data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } else {
    console.log('   Downloading from GitHub...');
    data = await fetchWithRetry(CONFIG.animeOfflineDbUrl, { timeout: 60000 });
    
    // Save locally for future use
    fs.writeFileSync(localPath, JSON.stringify(data, null, 2));
    console.log('   Saved to local cache');
  }
  
  // Build lookup maps by MAL ID and Kitsu ID
  const synonymsByMalId = new Map();
  const synonymsByKitsuId = new Map();
  
  for (const anime of data.data || []) {
    const synonyms = anime.synonyms || [];
    const title = anime.title;
    const allNames = [title, ...synonyms].filter(Boolean);
    
    // Extract IDs from sources
    for (const source of (anime.sources || [])) {
      const malMatch = source.match(/myanimelist\.net\/anime\/(\d+)/);
      if (malMatch) {
        synonymsByMalId.set(parseInt(malMatch[1]), allNames);
      }
      
      const kitsuMatch = source.match(/kitsu\.io\/anime\/(\d+)/);
      if (kitsuMatch) {
        synonymsByKitsuId.set(parseInt(kitsuMatch[1]), allNames);
      }
    }
  }
  
  console.log(`   MAL synonyms: ${synonymsByMalId.size.toLocaleString()} anime`);
  console.log(`   Kitsu synonyms: ${synonymsByKitsuId.size.toLocaleString()} anime`);
  
  return { synonymsByMalId, synonymsByKitsuId };
}

// ============================================================
// V5 ENHANCED IMDB MATCHING
// ============================================================

function findImdbMatchV5(anime, searchIndex, imdbTitles, synonyms = []) {
  const variations = generateTitleVariations(anime.name, synonyms);
  
  // Collect all candidates
  const candidates = new Map();
  
  // Find candidates from exact/fuzzy title matches
  for (const [indexTitle, entries] of searchIndex) {
    for (const variation of variations) {
      // Exact match - add candidate
      if (variation === indexTitle) {
        for (const entry of entries) {
          candidates.set(entry.id, entry);
        }
      } else {
        // Fuzzy match
        const sim = similarity(variation, indexTitle);
        if (sim >= CONFIG.scoring.minTitleSimilarity) {
          for (const entry of entries) {
            candidates.set(entry.id, entry);
          }
        }
      }
    }
  }
  
  if (candidates.size === 0) {
    return null;
  }
  
  // Score all candidates
  const scoredCandidates = [];
  
  for (const [imdbId, candidate] of candidates) {
    const scoreResult = calculateMatchScore(anime, candidate, synonyms);
    
    scoredCandidates.push({
      imdbId,
      candidate,
      ...scoreResult,
    });
  }
  
  // Sort by total score
  scoredCandidates.sort((a, b) => b.totalScore - a.totalScore);
  
  // Return best match if above threshold
  const best = scoredCandidates[0];
  
  if (!best) return null;
  
  // Get top 3 for reporting
  const topCandidates = scoredCandidates.slice(0, 3).map(c => ({
    imdbId: c.imdbId,
    title: c.candidate.title,
    year: c.candidate.year,
    score: c.totalScore,
    confidence: c.confidence,
  }));
  
  return {
    imdbId: best.imdbId,
    score: best.totalScore,
    confidence: best.confidence,
    breakdown: best.breakdown,
    topCandidates,
    accepted: best.confidence === 'high' || best.confidence === 'medium',
  };
}

// ============================================================
// KITSU API
// ============================================================

async function fetchKitsuPage(offset = 0) {
  const url = `${CONFIG.kitsuBaseUrl}/anime?page[limit]=${CONFIG.kitsuPageSize}&page[offset]=${offset}&sort=-userCount`;
  return fetchWithRetry(url, { headers: { 'Accept': 'application/vnd.api+json' } });
}

async function fetchAllKitsuAnime() {
  console.log('\n🐱 Fetching Kitsu catalog...');
  
  const allAnime = [];
  let offset = 0;
  let hasMore = true;
  
  while (hasMore) {
    const data = await fetchKitsuPage(offset);
    
    if (!data || !data.data || data.data.length === 0) {
      hasMore = false;
      break;
    }
    
    for (const item of data.data) {
      const attrs = item.attributes;
      
      allAnime.push({
        kitsuId: parseInt(item.id),
        name: attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp,
        slug: attrs.slug,
        description: attrs.synopsis,
        year: attrs.startDate ? parseInt(attrs.startDate.split('-')[0]) : null,
        season: attrs.startDate ? getSeasonFromDate(attrs.startDate) : null,
        status: attrs.status?.toUpperCase(),
        rating: attrs.averageRating ? parseFloat(attrs.averageRating) / 10 : null,
        poster: attrs.posterImage?.large || attrs.posterImage?.original,
        background: attrs.coverImage?.large || attrs.coverImage?.original,
        genres: [],
        episodeCount: attrs.episodeCount,
        runtime: attrs.episodeLength ? `${attrs.episodeLength} min` : null,
        ageRating: attrs.ageRating,
        subtype: attrs.subtype,
        popularity: attrs.userCount,
        titles: attrs.titles,
      });
    }
    
    offset += CONFIG.kitsuPageSize;
    
    process.stdout.write(`\r   Fetched ${allAnime.length.toLocaleString()} anime...`);
    
    if (TEST_MODE && allAnime.length >= TEST_LIMIT) {
      hasMore = false;
    }
    
    await sleep(CONFIG.requestDelay);
  }
  
  console.log(`\n   Total: ${allAnime.length.toLocaleString()} anime`);
  stats.totalKitsu = allAnime.length;
  
  return allAnime;
}

function getSeasonFromDate(dateStr) {
  if (!dateStr) return null;
  const month = parseInt(dateStr.split('-')[1]);
  if (month >= 1 && month <= 3) return 'winter';
  if (month >= 4 && month <= 6) return 'spring';
  if (month >= 7 && month <= 9) return 'summer';
  return 'fall';
}

async function fetchKitsuGenres(kitsuId) {
  try {
    const url = `${CONFIG.kitsuBaseUrl}/anime/${kitsuId}/genres`;
    const data = await fetchWithRetry(url, { headers: { 'Accept': 'application/vnd.api+json' } });
    
    if (data && data.data) {
      return data.data.map(g => g.attributes.name);
    }
  } catch (e) {
    // Ignore errors
  }
  return [];
}

// ============================================================
// CINEMETA ENRICHMENT
// ============================================================

async function enrichFromCinemeta(anime) {
  if (!anime.imdbId) return anime;
  
  try {
    const url = `${CONFIG.cinemataBase}/series/${anime.imdbId}.json`;
    const data = await fetchWithRetry(url, { timeout: 10000 });
    
    if (data && data.meta) {
      const meta = data.meta;
      stats.cinemataEnriched++;
      
      if (meta.logo && !anime.logo) {
        anime.logo = meta.logo;
        stats.cinemataLogos++;
      }
      
      if (meta.background && !anime.background) {
        anime.background = meta.background;
        stats.cinemataBackgrounds++;
      }
      
      if (meta.cast && meta.cast.length > 0 && (!anime.cast || anime.cast.length === 0)) {
        anime.cast = meta.cast.slice(0, 10);
        stats.cinemataCast++;
      }
      
      if (meta.genres && meta.genres.length > 0) {
        anime.genres = [...new Set([...anime.genres, ...meta.genres])];
      }
    }
  } catch (e) {
    // Ignore errors
  }
  
  return anime;
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
    .trim();
}

function groupSeasons(animeList) {
  console.log('\n🔗 Grouping seasons by IMDB ID...');
  
  const byImdbId = new Map();
  
  for (const anime of animeList) {
    if (!anime.imdbId) continue;
    
    if (!byImdbId.has(anime.imdbId)) {
      byImdbId.set(anime.imdbId, []);
    }
    byImdbId.get(anime.imdbId).push(anime);
  }
  
  const grouped = [];
  let mergedCount = 0;
  
  for (const [imdbId, entries] of byImdbId) {
    // Sort by year and popularity
    entries.sort((a, b) => {
      if (a.year !== b.year) return (a.year || 9999) - (b.year || 9999);
      return (b.popularity || 0) - (a.popularity || 0);
    });
    
    // Use first entry as base
    const base = { ...entries[0] };
    
    if (entries.length > 1) {
      // Merge episode counts
      base.episodeCount = entries.reduce((sum, e) => sum + (e.episodeCount || 0), 0);
      
      // Use best rating
      const ratings = entries.filter(e => e.rating).map(e => e.rating);
      if (ratings.length > 0) {
        base.rating = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
      }
      
      // Combine genres
      const allGenres = new Set();
      for (const e of entries) {
        for (const g of (e.genres || [])) {
          allGenres.add(g);
        }
      }
      base.genres = Array.from(allGenres);
      
      // Mark as merged
      base._mergedSeasons = entries.length;
      mergedCount++;
    }
    
    grouped.push(base);
  }
  
  // Add anime without IMDB IDs
  for (const anime of animeList) {
    if (!anime.imdbId) {
      grouped.push(anime);
    }
  }
  
  console.log(`   Merged ${mergedCount} multi-season entries`);
  console.log(`   Final count: ${grouped.length.toLocaleString()} anime`);
  
  return grouped;
}

// ============================================================
// FILTER OPTIONS
// ============================================================

function generateFilterOptions(catalog) {
  const genres = new Map();
  const years = new Map();
  const seasons = new Map();
  const statuses = new Map();
  
  for (const anime of catalog) {
    // Genres
    for (const genre of (anime.genres || [])) {
      genres.set(genre, (genres.get(genre) || 0) + 1);
    }
    
    // Years
    if (anime.year) {
      years.set(anime.year, (years.get(anime.year) || 0) + 1);
    }
    
    // Seasons
    if (anime.season) {
      seasons.set(anime.season, (seasons.get(anime.season) || 0) + 1);
    }
    
    // Status
    if (anime.status) {
      statuses.set(anime.status, (statuses.get(anime.status) || 0) + 1);
    }
  }
  
  return {
    genres: Object.fromEntries([...genres.entries()].sort((a, b) => b[1] - a[1])),
    years: Object.fromEntries([...years.entries()].sort((a, b) => b[0] - a[0])),
    seasons: Object.fromEntries([...seasons.entries()].sort((a, b) => b[1] - a[1])),
    statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => b[1] - a[1])),
  };
}

// ============================================================
// MAIN BUILD PROCESS
// ============================================================

async function build() {
  const startTime = Date.now();
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       AnimeStream Database Builder v5 (Multi-Gate Scoring)');
  console.log('═══════════════════════════════════════════════════════════════');
  
  if (TEST_MODE) {
    console.log('⚠️  TEST MODE: Limited to', TEST_LIMIT, 'items');
  }
  
  // Ensure directories exist
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  if (!fs.existsSync(CONFIG.imdbDir)) {
    fs.mkdirSync(CONFIG.imdbDir, { recursive: true });
  }
  
  // Load all data sources
  const [fribbMappings, imdbData, synonymsData] = await Promise.all([
    loadFribbMappings(),
    loadImdbData(),
    loadAnimeOfflineDatabase(),
  ]);
  
  const { malToImdb, kitsuToImdb } = fribbMappings;
  const { imdbTitles, searchIndex } = imdbData;
  const { synonymsByMalId, synonymsByKitsuId } = synonymsData;
  
  // Fetch Kitsu catalog
  const kitsuAnime = await fetchAllKitsuAnime();
  
  // Match IMDB IDs
  console.log('\n🎯 Matching IMDB IDs (v5 multi-gate scoring)...');
  
  const matchReport = {
    high: [],
    medium: [],
    low: [],
    noMatch: [],
  };
  
  let processed = 0;
  
  for (const anime of kitsuAnime) {
    processed++;
    
    if (processed % 100 === 0) {
      process.stdout.write(`\r   ${progressBar(processed, kitsuAnime.length)}`);
    }
    
    // Get synonyms for this anime
    const synonyms = synonymsByKitsuId.get(anime.kitsuId) || [];
    
    // Fetch genres from Kitsu
    if (anime.genres.length === 0) {
      anime.genres = await fetchKitsuGenres(anime.kitsuId);
      await sleep(50);
    }
    
    // Try Fribb mapping first (highest confidence)
    if (kitsuToImdb.has(anime.kitsuId)) {
      anime.imdbId = kitsuToImdb.get(anime.kitsuId);
      anime._matchSource = 'fribb_kitsu';
      stats.matchedFribb++;
      continue;
    }
    
    // Try V5 multi-gate matching
    const matchResult = findImdbMatchV5(anime, searchIndex, imdbTitles, synonyms);
    
    if (matchResult) {
      if (matchResult.accepted) {
        anime.imdbId = matchResult.imdbId;
        anime._matchSource = `imdb_v5_${matchResult.confidence}`;
        anime._matchScore = matchResult.score;
        
        if (matchResult.confidence === 'high') {
          stats.matchedImdbHigh++;
          matchReport.high.push({
            name: anime.name,
            year: anime.year,
            imdbId: matchResult.imdbId,
            score: matchResult.score,
            breakdown: matchResult.breakdown,
          });
        } else {
          stats.matchedImdbMedium++;
          matchReport.medium.push({
            name: anime.name,
            year: anime.year,
            imdbId: matchResult.imdbId,
            score: matchResult.score,
            breakdown: matchResult.breakdown,
            topCandidates: matchResult.topCandidates,
          });
        }
      } else {
        // Low confidence - don't use
        stats.matchedImdbLow++;
        matchReport.low.push({
          name: anime.name,
          year: anime.year,
          topCandidates: matchResult.topCandidates,
          score: matchResult.score,
        });
        stats.noMatch++;
      }
    } else {
      stats.noMatch++;
      matchReport.noMatch.push({
        name: anime.name,
        year: anime.year,
        kitsuId: anime.kitsuId,
        subtype: anime.subtype,
      });
    }
  }
  
  console.log('\n');
  
  // Group seasons
  const grouped = groupSeasons(kitsuAnime);
  
  // Enrich from Cinemeta
  if (!SKIP_CINEMETA) {
    console.log('\n🎬 Enriching from Cinemeta...');
    
    const withImdb = grouped.filter(a => a.imdbId);
    let enriched = 0;
    
    for (let i = 0; i < withImdb.length; i += CONFIG.cinemataBatchSize) {
      const batch = withImdb.slice(i, i + CONFIG.cinemataBatchSize);
      
      await Promise.all(batch.map(anime => enrichFromCinemeta(anime)));
      
      enriched += batch.length;
      process.stdout.write(`\r   ${progressBar(enriched, withImdb.length)}`);
      
      await sleep(CONFIG.cinemataDelayMs);
    }
    
    console.log('\n');
  }
  
  // Format final catalog
  console.log('\n📝 Formatting catalog...');
  
  const catalog = grouped.map(anime => ({
    id: anime.imdbId || `mal-${anime.kitsuId}`,
    imdb_id: anime.imdbId || null,
    kitsu_id: anime.kitsuId,
    mal_id: anime.malId || null,
    type: 'series',
    name: anime.name,
    slug: anime.slug,
    description: anime.description,
    year: anime.year,
    season: anime.season,
    status: anime.status,
    rating: anime.rating,
    poster: anime.poster,
    background: anime.background,
    logo: anime.logo || (anime.imdbId ? `https://images.metahub.space/logo/medium/${anime.imdbId}/img` : null),
    cast: anime.cast || [],
    genres: anime.genres || [],
    episodeCount: anime.episodeCount,
    runtime: anime.runtime,
    ageRating: anime.ageRating,
    subtype: anime.subtype,
    popularity: anime.popularity,
    _matchSource: anime._matchSource,
    _matchScore: anime._matchScore,
    _mergedSeasons: anime._mergedSeasons,
  }));
  
  // Sort by popularity
  catalog.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  
  // Save catalog
  const catalogOutput = {
    buildDate: new Date().toISOString(),
    version: '5.0',
    source: 'kitsu+fribb+imdb_v5_multigate+cinemeta',
    stats: {
      totalAnime: catalog.length,
      fromFribb: stats.matchedFribb,
      fromImdbHigh: stats.matchedImdbHigh,
      fromImdbMedium: stats.matchedImdbMedium,
      noMatch: stats.noMatch,
      cinemeta: {
        enriched: stats.cinemataEnriched,
        logos: stats.cinemataLogos,
        backgrounds: stats.cinemataBackgrounds,
        cast: stats.cinemataCast,
      },
    },
    catalog,
  };
  
  const catalogPath = path.join(CONFIG.outputDir, CONFIG.catalogFile);
  fs.writeFileSync(catalogPath, JSON.stringify(catalogOutput, null, 2));
  console.log(`   Saved: ${catalogPath} (${formatSize(fs.statSync(catalogPath).size)})`);
  
  // Save filter options
  const filterOptions = generateFilterOptions(catalog);
  const filterPath = path.join(CONFIG.outputDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   Saved: ${filterPath}`);
  
  // Save match report
  const reportPath = path.join(CONFIG.outputDir, CONFIG.matchReportFile);
  fs.writeFileSync(reportPath, JSON.stringify(matchReport, null, 2));
  console.log(`   Saved: ${reportPath} (${formatSize(fs.statSync(reportPath).size)})`);
  
  // Print summary
  const duration = Date.now() - startTime;
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                        BUILD SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total Kitsu anime:     ${stats.totalKitsu.toLocaleString()}`);
  console.log(`  Matched (Fribb):       ${stats.matchedFribb.toLocaleString()} (highest confidence)`);
  console.log(`  Matched (IMDB High):   ${stats.matchedImdbHigh.toLocaleString()} (≥80 pts, auto-accept)`);
  console.log(`  Matched (IMDB Medium): ${stats.matchedImdbMedium.toLocaleString()} (60-79 pts, accepted)`);
  console.log(`  Rejected (Low):        ${stats.matchedImdbLow.toLocaleString()} (<60 pts)`);
  console.log(`  No match found:        ${stats.noMatch.toLocaleString()}`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  Cinemeta enriched:     ${stats.cinemataEnriched.toLocaleString()}`);
  console.log(`    - Logos:             ${stats.cinemataLogos.toLocaleString()}`);
  console.log(`    - Backgrounds:       ${stats.cinemataBackgrounds.toLocaleString()}`);
  console.log(`    - Cast:              ${stats.cinemataCast.toLocaleString()}`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  Final catalog:         ${catalog.length.toLocaleString()} anime`);
  console.log(`  Build time:            ${formatDuration(duration)}`);
  console.log('═══════════════════════════════════════════════════════════════');
  
  // Show some medium-confidence matches for review
  if (matchReport.medium.length > 0) {
    console.log('\n⚠️  Sample medium-confidence matches (60-79 pts) - review recommended:');
    for (const match of matchReport.medium.slice(0, 5)) {
      console.log(`   ${match.name} (${match.year}) → ${match.imdbId} (score: ${match.score})`);
    }
    console.log(`   ... and ${Math.max(0, matchReport.medium.length - 5)} more in ${CONFIG.matchReportFile}`);
  }
}

// Run
build().catch(err => {
  console.error('\n❌ Build failed:', err);
  process.exit(1);
});
