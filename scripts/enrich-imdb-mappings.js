#!/usr/bin/env node
/**
 * IMDB Mapping Enrichment Script
 * 
 * Uses IMDB's free non-commercial datasets to find IMDB IDs for anime
 * that don't have mappings in Fribb/anime-lists.
 * 
 * IMDB Dataset Files (from https://datasets.imdbws.com/):
 * - title.basics.tsv.gz: tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtimeMinutes, genres
 * - title.akas.tsv.gz: titleId, ordering, title, region, language, types, attributes, isOriginalTitle
 * 
 * Strategy:
 * 1. Download and parse IMDB datasets
 * 2. Filter to relevant types (tvSeries, tvMiniSeries, movie, video)
 * 3. Filter by genre containing "Animation" 
 * 4. Build a smart matching system using:
 *    - Exact title match (normalized)
 *    - Fuzzy title match (Levenshtein with 85%+ threshold)
 *    - Year validation (±2 years tolerance)
 *    - Alternative titles from title.akas
 *    - Japanese romaji/English title variations
 * 
 * Usage:
 *   node scripts/enrich-imdb-mappings.js              # Full run
 *   node scripts/enrich-imdb-mappings.js --download   # Download datasets first
 *   node scripts/enrich-imdb-mappings.js --dry-run    # Preview without saving
 *   node scripts/enrich-imdb-mappings.js --verbose    # Show match details
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const https = require('https');
const http = require('http');

// CLI flags
const DOWNLOAD_ONLY = process.argv.includes('--download');
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Configuration
const CONFIG = {
  dataDir: path.join(__dirname, '..', 'data'),
  imdbDir: path.join(__dirname, '..', 'data', 'imdb'),
  
  // IMDB dataset URLs
  imdbBasicsUrl: 'https://datasets.imdbws.com/title.basics.tsv.gz',
  imdbAkasUrl: 'https://datasets.imdbws.com/title.akas.tsv.gz',
  
  // Matching configuration
  minSimilarity: 0.85,        // 85% minimum similarity for fuzzy match
  yearTolerance: 2,           // ±2 years for year matching
  minTitleLength: 3,          // Minimum title length to consider
  
  // Relevant IMDB title types for anime
  relevantTypes: ['tvSeries', 'tvMiniSeries', 'movie', 'video', 'tvMovie', 'tvSpecial'],
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressBar(current, total, width = 30) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${percent}%`;
}

// ============================================================
// TITLE NORMALIZATION (Critical for matching)
// ============================================================

/**
 * Normalize a title for matching
 * This is the core of the matching algorithm
 */
function normalizeTitle(title) {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .trim()
    // Remove content in parentheses (often year or language info)
    .replace(/\([^)]*\)/g, '')
    // Remove content in brackets [TV], [Movie], etc.
    .replace(/\[[^\]]*\]/g, '')
    // Convert Japanese punctuation to spaces
    .replace(/[：・「」『』【】〈〉《》（）]/g, ' ')
    // Remove special characters but keep alphanumeric and spaces
    .replace(/[^\w\s\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf-]/g, '')
    // Normalize unicode (ā → a, ū → u, etc.)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Normalize romanization variations
    .replace(/ou/g, 'o')    // ō variants
    .replace(/uu/g, 'u')    // ū variants
    .replace(/aa/g, 'a')    // ā variants
    .replace(/ii/g, 'i')    // ī variants
    .replace(/ee/g, 'e')    // ē variants
    // Remove common suffixes that vary between sources
    .replace(/\s+(the\s+)?(animation|animated|anime|ova|ona|movie|film|special|tv|series)s?$/gi, '')
    .replace(/\s+(season|part|cour|chapter|arc)\s*\d*$/gi, '')
    .replace(/\s+(1st|2nd|3rd|\d+th)\s+(season|part|cour)$/gi, '')
    .replace(/\s+[ivx]+$/gi, '')  // Roman numerals at end (II, III, IV)
    // Remove episode/season markers
    .replace(/\s*s\d+\s*/gi, ' ')
    .replace(/\s*ep\.?\s*\d+/gi, '')
    // Common word substitutions
    .replace(/\band\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\ba\b/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .replace(/-+/g, ' ')
    .trim();
}

/**
 * Extract base title (removes sequel indicators)
 * "Attack on Titan Season 4" → "Attack on Titan"
 */
function extractBaseTitle(title) {
  if (!title) return '';
  
  return title
    // Remove season indicators
    .replace(/:\s*(season|part|cour)\s*\d+/gi, '')
    .replace(/\s+(season|part|cour)\s*\d+/gi, '')
    .replace(/\s+\d+(st|nd|rd|th)\s+(season|part)/gi, '')
    // Remove roman numeral suffixes (II, III, IV)
    .replace(/\s+[IVX]+$/gi, '')
    // Remove "2", "3" etc at end
    .replace(/\s+\d+$/g, '')
    // Remove subtitles after colon
    .replace(/:\s*[^:]+$/g, '')
    .trim();
}

/**
 * Generate title variations for matching
 * Returns array of normalized variations to try
 */
function generateTitleVariations(title, originalTitle) {
  const variations = new Set();
  
  // Original and normalized
  if (title) {
    variations.add(normalizeTitle(title));
    variations.add(normalizeTitle(extractBaseTitle(title)));
  }
  
  if (originalTitle && originalTitle !== title) {
    variations.add(normalizeTitle(originalTitle));
    variations.add(normalizeTitle(extractBaseTitle(originalTitle)));
  }
  
  // Without "the" prefix
  if (title) {
    const noThe = title.replace(/^the\s+/i, '');
    if (noThe !== title) variations.add(normalizeTitle(noThe));
  }
  
  return [...variations].filter(v => v.length >= CONFIG.minTitleLength);
}

// ============================================================
// SIMILARITY CALCULATION
// ============================================================

/**
 * Calculate Levenshtein distance
 */
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

/**
 * Calculate similarity score (0-1)
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  
  if (longer.length === 0) return 1;
  
  // Quick reject: too different in length
  if (shorter.length < longer.length * 0.5) return 0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/**
 * Check if titles match with smart matching
 */
function titlesMatch(animeTitle, animeOriginalTitle, imdbTitle, year1, year2) {
  const animeVariations = generateTitleVariations(animeTitle, animeOriginalTitle);
  const imdbNormalized = normalizeTitle(imdbTitle);
  const imdbBase = normalizeTitle(extractBaseTitle(imdbTitle));
  
  // Year validation (if both have years)
  if (year1 && year2) {
    const yearDiff = Math.abs(parseInt(year1) - parseInt(year2));
    if (yearDiff > CONFIG.yearTolerance) {
      return { match: false, score: 0, reason: 'year_mismatch' };
    }
  }
  
  // Check each variation
  for (const variation of animeVariations) {
    // Exact match
    if (variation === imdbNormalized || variation === imdbBase) {
      return { match: true, score: 1.0, reason: 'exact' };
    }
    
    // Fuzzy match
    const simScore = Math.max(
      similarity(variation, imdbNormalized),
      similarity(variation, imdbBase)
    );
    
    if (simScore >= CONFIG.minSimilarity) {
      return { match: true, score: simScore, reason: 'fuzzy' };
    }
  }
  
  return { match: false, score: 0, reason: 'no_match' };
}

// ============================================================
// IMDB DATA LOADING
// ============================================================

/**
 * Download a file with progress
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    
    console.log(`   Downloading: ${url}`);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirect
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          process.stdout.write(`\r   ${progressBar(downloadedSize, totalSize)} ${formatSize(downloadedSize)}/${formatSize(totalSize)}`);
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log('\n   ✅ Download complete');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Download IMDB datasets if not present
 */
async function downloadImdbDatasets() {
  if (!fs.existsSync(CONFIG.imdbDir)) {
    fs.mkdirSync(CONFIG.imdbDir, { recursive: true });
  }
  
  const basicsPath = path.join(CONFIG.imdbDir, 'title.basics.tsv.gz');
  const akasPath = path.join(CONFIG.imdbDir, 'title.akas.tsv.gz');
  
  // Check if files exist and are recent (within 7 days)
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  const needBasics = !fs.existsSync(basicsPath) || 
    (Date.now() - fs.statSync(basicsPath).mtime.getTime() > maxAge);
  const needAkas = !fs.existsSync(akasPath) || 
    (Date.now() - fs.statSync(akasPath).mtime.getTime() > maxAge);
  
  if (needBasics) {
    console.log('\n📥 Downloading title.basics.tsv.gz (~150MB)...');
    await downloadFile(CONFIG.imdbBasicsUrl, basicsPath);
  } else {
    console.log('   ✅ title.basics.tsv.gz is up to date');
  }
  
  if (needAkas) {
    console.log('\n📥 Downloading title.akas.tsv.gz (~300MB)...');
    await downloadFile(CONFIG.imdbAkasUrl, akasPath);
  } else {
    console.log('   ✅ title.akas.tsv.gz is up to date');
  }
  
  return { basicsPath, akasPath };
}

/**
 * Parse IMDB basics file and filter to animation
 * Returns Map<imdbId, { title, originalTitle, year, type, genres }>
 */
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
    
    // Filter criteria:
    // 1. Must be a relevant type
    // 2. Must have Animation in genres
    // 3. Not adult content (for safety)
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
      endYear: row.endYear !== '\\N' ? parseInt(row.endYear) : null,
      type: titleType,
      genres: genres.split(','),
      runtime: row.runtimeMinutes !== '\\N' ? parseInt(row.runtimeMinutes) : null,
    });
    
    animationCount++;
  }
  
  console.log(`\n   ✅ Loaded ${animationCount} animation titles from ${lineCount} total`);
  return imdbData;
}

/**
 * Load alternative titles from title.akas
 * Returns Map<imdbId, Set<alternativeTitles>>
 */
async function loadImdbAkas(filePath, relevantIds) {
  console.log('\n📖 Loading IMDB alternative titles...');
  
  const akasMap = new Map();
  let lineCount = 0;
  let relevantCount = 0;
  
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
      process.stdout.write(`\r   Processed ${(lineCount / 1000000).toFixed(1)}M lines, found ${relevantCount} relevant titles`);
    }
    
    const values = line.split('\t');
    const titleId = values[0];
    
    // Only process IDs we care about (animation titles)
    if (!relevantIds.has(titleId)) continue;
    
    const title = values[2]; // title column
    const region = values[3]; // region
    const language = values[4]; // language
    
    if (title && title !== '\\N') {
      if (!akasMap.has(titleId)) {
        akasMap.set(titleId, new Set());
      }
      akasMap.get(titleId).add(title);
      
      // Prioritize Japanese (JP) and English (US, GB) titles
      if (['JP', 'US', 'GB', 'XWW'].includes(region)) {
        relevantCount++;
      }
    }
  }
  
  console.log(`\n   ✅ Loaded alternative titles for ${akasMap.size} animation titles`);
  return akasMap;
}

/**
 * Build a search index from IMDB data
 * Returns Map<normalizedTitle, [imdbEntry, ...]>
 */
function buildSearchIndex(imdbData, akasMap) {
  console.log('\n🔧 Building search index...');
  
  const index = new Map();
  let indexedTitles = 0;
  
  for (const [imdbId, entry] of imdbData) {
    // Index primary title
    const normalized = normalizeTitle(entry.title);
    if (normalized.length >= CONFIG.minTitleLength) {
      if (!index.has(normalized)) index.set(normalized, []);
      index.get(normalized).push(entry);
      indexedTitles++;
    }
    
    // Index original title
    if (entry.originalTitle) {
      const normOriginal = normalizeTitle(entry.originalTitle);
      if (normOriginal.length >= CONFIG.minTitleLength && normOriginal !== normalized) {
        if (!index.has(normOriginal)) index.set(normOriginal, []);
        index.get(normOriginal).push(entry);
        indexedTitles++;
      }
    }
    
    // Index alternative titles
    const akas = akasMap.get(imdbId);
    if (akas) {
      for (const aka of akas) {
        const normAka = normalizeTitle(aka);
        if (normAka.length >= CONFIG.minTitleLength && normAka !== normalized) {
          if (!index.has(normAka)) index.set(normAka, []);
          if (!index.get(normAka).some(e => e.id === imdbId)) {
            index.get(normAka).push(entry);
            indexedTitles++;
          }
        }
      }
    }
  }
  
  console.log(`   ✅ Indexed ${indexedTitles} title variations for ${imdbData.size} entries`);
  return index;
}

// ============================================================
// ANIME MATCHING
// ============================================================

/**
 * Find best IMDB match for an anime
 */
function findImdbMatch(anime, searchIndex, imdbData, akasMap) {
  const animeVariations = generateTitleVariations(anime.name, anime.slug);
  
  let bestMatch = null;
  let bestScore = 0;
  let matchReason = null;
  
  // Strategy 1: Exact normalized title lookup
  for (const variation of animeVariations) {
    if (searchIndex.has(variation)) {
      const candidates = searchIndex.get(variation);
      
      for (const candidate of candidates) {
        // Validate year if both have it
        if (anime.year && candidate.year) {
          const yearDiff = Math.abs(anime.year - candidate.year);
          if (yearDiff > CONFIG.yearTolerance) continue;
        }
        
        // Exact match found!
        if (bestScore < 1.0) {
          bestMatch = candidate;
          bestScore = 1.0;
          matchReason = 'exact';
        }
      }
    }
  }
  
  // Strategy 2: Fuzzy matching if no exact match
  if (!bestMatch) {
    for (const [indexTitle, candidates] of searchIndex) {
      for (const variation of animeVariations) {
        const simScore = similarity(variation, indexTitle);
        
        if (simScore >= CONFIG.minSimilarity && simScore > bestScore) {
          for (const candidate of candidates) {
            // Year validation
            if (anime.year && candidate.year) {
              const yearDiff = Math.abs(anime.year - candidate.year);
              if (yearDiff > CONFIG.yearTolerance) continue;
            }
            
            // Type preference: prefer tvSeries for anime series
            let typeBonus = 0;
            if (candidate.type === 'tvSeries' || candidate.type === 'tvMiniSeries') {
              typeBonus = 0.02;
            }
            
            const adjustedScore = simScore + typeBonus;
            if (adjustedScore > bestScore) {
              bestMatch = candidate;
              bestScore = adjustedScore;
              matchReason = 'fuzzy';
            }
          }
        }
      }
    }
  }
  
  if (bestMatch && bestScore >= CONFIG.minSimilarity) {
    return {
      imdbId: bestMatch.id,
      imdbTitle: bestMatch.title,
      year: bestMatch.year,
      type: bestMatch.type,
      score: bestScore,
      reason: matchReason,
    };
  }
  
  return null;
}

// ============================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================

async function enrichImdbMappings() {
  const startTime = Date.now();
  
  console.log('\n============================================================');
  console.log('       IMDB Mapping Enrichment via Dataset Matching');
  console.log('============================================================\n');
  
  if (DRY_RUN) console.log('🔍 DRY RUN - no changes will be saved\n');
  
  // Step 1: Download datasets if needed
  console.log('📥 Step 1: Checking IMDB datasets...');
  const { basicsPath, akasPath } = await downloadImdbDatasets();
  
  if (DOWNLOAD_ONLY) {
    console.log('\n✅ Download complete. Run without --download to process.');
    return;
  }
  
  // Step 2: Load IMDB data
  console.log('\n📖 Step 2: Loading IMDB data...');
  const imdbData = await loadImdbBasics(basicsPath);
  const akasMap = await loadImdbAkas(akasPath, imdbData);
  
  // Step 3: Build search index
  console.log('\n🔧 Step 3: Building search index...');
  const searchIndex = buildSearchIndex(imdbData, akasMap);
  
  // Step 4: Load our anime catalog
  console.log('\n📂 Step 4: Loading anime catalog...');
  const catalogPath = path.join(CONFIG.dataDir, 'catalog.json.gz');
  const catalogData = JSON.parse(zlib.gunzipSync(fs.readFileSync(catalogPath)));
  console.log(`   Loaded ${catalogData.catalog.length} anime`);
  
  // Step 5: Find anime without IMDB IDs
  const withoutImdb = catalogData.catalog.filter(a => !a.imdb_id || !a.imdb_id.startsWith('tt'));
  const withImdb = catalogData.catalog.filter(a => a.imdb_id && a.imdb_id.startsWith('tt'));
  console.log(`   Already have IMDB: ${withImdb.length}`);
  console.log(`   Missing IMDB: ${withoutImdb.length}`);
  
  // Step 6: Match anime to IMDB
  console.log('\n🔍 Step 5: Matching anime to IMDB...\n');
  
  let matched = 0;
  let noMatch = 0;
  const newMappings = [];
  
  for (let i = 0; i < withoutImdb.length; i++) {
    const anime = withoutImdb[i];
    
    if (i % 100 === 0) {
      process.stdout.write(`\r   ${progressBar(i, withoutImdb.length)} - ${matched} matched, ${noMatch} unmatched`);
    }
    
    const match = findImdbMatch(anime, searchIndex, imdbData, akasMap);
    
    if (match) {
      matched++;
      newMappings.push({
        anime: anime.name,
        kitsuId: anime.kitsu_id,
        imdbId: match.imdbId,
        imdbTitle: match.imdbTitle,
        score: match.score,
        reason: match.reason,
      });
      
      // Update the anime entry
      anime.imdb_id = match.imdbId;
      anime.id = match.imdbId; // Use IMDB as primary ID
      
      if (VERBOSE) {
        console.log(`\n   ✓ "${anime.name}" → ${match.imdbId} (${match.imdbTitle}) [${match.reason}, ${(match.score * 100).toFixed(0)}%]`);
      }
    } else {
      noMatch++;
      if (VERBOSE) {
        console.log(`\n   ✗ "${anime.name}" - no match found`);
      }
    }
  }
  
  console.log(`\n\n   📊 Results: ${matched} new matches, ${noMatch} unmatched`);
  
  // Step 7: Save results
  if (!DRY_RUN && matched > 0) {
    console.log('\n💾 Step 6: Saving updated catalog...');
    
    // Update catalog
    const jsonContent = JSON.stringify(catalogData, null, 2);
    fs.writeFileSync(path.join(CONFIG.dataDir, 'catalog.json'), jsonContent);
    fs.writeFileSync(catalogPath, zlib.gzipSync(jsonContent));
    
    console.log(`   ✅ Updated catalog.json.gz`);
    
    // Save mapping report
    const reportPath = path.join(CONFIG.dataDir, 'imdb-enrichment-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      date: new Date().toISOString(),
      totalAnime: catalogData.catalog.length,
      previouslyMapped: withImdb.length,
      newlyMapped: matched,
      stillUnmapped: noMatch,
      mappings: newMappings,
    }, null, 2));
    
    console.log(`   ✅ Saved report to ${reportPath}`);
  }
  
  // Summary
  const duration = Date.now() - startTime;
  console.log('\n============================================================');
  console.log('                    Summary');
  console.log('============================================================');
  console.log(`   Total anime: ${catalogData.catalog.length}`);
  console.log(`   Previously mapped: ${withImdb.length}`);
  console.log(`   Newly matched: ${matched}`);
  console.log(`   Still unmapped: ${noMatch}`);
  console.log(`   New total with IMDB: ${withImdb.length + matched}`);
  console.log(`   Duration: ${Math.round(duration / 1000)}s`);
  console.log('============================================================\n');
  
  // Show some unmatched examples for debugging
  if (VERBOSE && noMatch > 0) {
    console.log('\n📋 Sample unmatched anime:');
    const unmatchedSample = withoutImdb
      .filter(a => !a.imdb_id || !a.imdb_id.startsWith('tt'))
      .slice(0, 10);
    for (const anime of unmatchedSample) {
      console.log(`   - ${anime.name} (${anime.year || 'no year'})`);
    }
  }
}

// Run
enrichImdbMappings().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (VERBOSE) console.error(err.stack);
  process.exit(1);
});
