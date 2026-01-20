/**
 * NSFW Content Filter Script
 * 
 * Uses the HentaiStream database (4000+ hentai titles) to identify and filter
 * NSFW content from the AnimeStream catalog using multiple matching strategies:
 * 
 * 1. Exact title match (normalized)
 * 2. Fuzzy title match using Levenshtein distance
 * 3. NSFW genre detection
 * 4. Known hentai studio detection
 * 5. Manual blocklist for edge cases
 */

const fs = require('fs');
const path = require('path');

// ===== PATHS =====
const ANIME_CATALOG_PATH = path.join(__dirname, '../data/catalog.json');
const HENTAI_CATALOG_PATH = path.join(__dirname, '../../hentaistream-addon/data/catalog.json');
const OUTPUT_PATH = path.join(__dirname, '../data/catalog-filtered.json');
const NSFW_REPORT_PATH = path.join(__dirname, '../data/nsfw-report.json');

// ===== NSFW DETECTION PATTERNS =====

// Genres that indicate NSFW content (only truly adult genres)
const NSFW_GENRES = new Set([
  'hentai',
  'erotica',
  'smut',
  'adult',
  '18+',
  'r-18',
  'r18',
  'xxx'
]);

// Borderline genres that need additional confirmation
const BORDERLINE_GENRES = new Set([
  'ecchi',
  'yaoi',
  'yuri',
  'mature'
]);

// Known hentai studios
const HENTAI_STUDIOS = new Set([
  'pink pineapple',
  'milky animation label',
  'arms',
  'pixy',
  'queen bee',
  'mary jane',
  'nur',
  'pashmina',
  'lune pictures',
  't-rex',
  'collaboration works',
  'animac',
  'studio eromatick',
  'bootleg',
  'platinum milky',
  'suzuki mirano',
  'a1c',
  'magin label',
  'bunnywalker',
  'gold bear',
  'antechinus',
  'selfish',
  'cherry lips',
  'discovery',
  'murakami teruaki',
  'poro',
  'survive',
  'white bear'
]);

// Manual blocklist - titles that should always be blocked
const MANUAL_BLOCKLIST = new Set([
  // Add specific titles that slip through other detection
]);

// ===== UTILITY FUNCTIONS =====

/**
 * Normalize a string for comparison
 */
function normalize(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ')    // Normalize whitespace
    .trim();
}

/**
 * Generate slug from title
 */
function slugify(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshtein(a, b) {
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

/**
 * Calculate similarity ratio (0-1) between two strings
 */
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ===== MAIN DETECTION LOGIC =====

function loadCatalogs() {
  console.log('Loading catalogs...');
  
  const animeCatalog = JSON.parse(fs.readFileSync(ANIME_CATALOG_PATH, 'utf8'));
  const hentaiCatalog = JSON.parse(fs.readFileSync(HENTAI_CATALOG_PATH, 'utf8'));
  
  console.log(`  AnimeStream catalog: ${animeCatalog.catalog.length} entries`);
  console.log(`  HentaiStream catalog: ${hentaiCatalog.catalog.length} entries`);
  
  return { animeCatalog, hentaiCatalog };
}

function buildHentaiLookup(hentaiCatalog) {
  console.log('\nBuilding hentai lookup tables...');
  
  const lookup = {
    normalizedNames: new Set(),
    slugs: new Set(),
    words: new Map() // word -> count (for statistical detection)
  };
  
  for (const hentai of hentaiCatalog.catalog) {
    const normalizedName = normalize(hentai.name);
    lookup.normalizedNames.add(normalizedName);
    lookup.slugs.add(slugify(hentai.name));
    
    // Build word frequency map (excluding common words)
    const words = normalizedName.split(' ').filter(w => w.length > 2);
    for (const word of words) {
      lookup.words.set(word, (lookup.words.get(word) || 0) + 1);
    }
  }
  
  console.log(`  ${lookup.normalizedNames.size} unique normalized names`);
  console.log(`  ${lookup.slugs.size} unique slugs`);
  console.log(`  ${lookup.words.size} unique words tracked`);
  
  return lookup;
}

function detectNSFW(anime, hentaiLookup, hentaiCatalog) {
  const reasons = [];
  let confidence = 0;
  
  const normalizedName = normalize(anime.name);
  const slug = slugify(anime.name);
  
  // Skip very short names - too prone to false positives (e.g., "Orange", "Blue")
  const isShortName = normalizedName.length <= 10;
  
  // 1. Exact match with hentai database (only for longer names)
  if (!isShortName && hentaiLookup.normalizedNames.has(normalizedName)) {
    reasons.push('exact_title_match');
    confidence = 85; // Not 100% - could be coincidental
  }
  
  // 2. Slug match (only for longer names)
  if (!isShortName && hentaiLookup.slugs.has(slug)) {
    reasons.push('slug_match');
    confidence = Math.max(confidence, 80);
  }
  
  // 3. Fuzzy title match (threshold 0.90 for high precision)
  if (confidence < 70 && normalizedName.length > 15) {
    for (const hentaiName of hentaiLookup.normalizedNames) {
      // Only compare names of similar length
      if (Math.abs(normalizedName.length - hentaiName.length) > 5) continue;
      
      const sim = similarity(normalizedName, hentaiName);
      if (sim >= 0.90) {
        reasons.push(`fuzzy_match:${Math.round(sim * 100)}%`);
        confidence = Math.max(confidence, Math.round(sim * 90)); // Scale down
        break;
      }
    }
  }
  
  // 4. NSFW genre detection (definitive)
  if (anime.genres) {
    const nsfwGenres = anime.genres.filter(g => NSFW_GENRES.has(g.toLowerCase()));
    if (nsfwGenres.length > 0) {
      reasons.push(`nsfw_genre:${nsfwGenres.join(',')}`);
      confidence = 100; // Definitive - hentai genre means hentai
    }
  }
  
  // 5. Hentai studio detection (definitive)
  if (anime.studios) {
    const studios = Array.isArray(anime.studios) ? anime.studios : [anime.studios];
    const hentaiStudios = studios.filter(s => HENTAI_STUDIOS.has(s?.toLowerCase()));
    if (hentaiStudios.length > 0) {
      reasons.push(`hentai_studio:${hentaiStudios.join(',')}`);
      confidence = 100; // Definitive - hentai studio means hentai
    }
  }
  
  // 6. Manual blocklist
  if (MANUAL_BLOCKLIST.has(anime.id) || MANUAL_BLOCKLIST.has(normalizedName)) {
    reasons.push('manual_blocklist');
    confidence = 100;
  }
  
  // 7. Check for common hentai title patterns
  const hentaiPatterns = [
    /\bova\b.*\b(episode|vol)/i,
    /\bthe animation\b/i,  // Many hentai use "The Animation" suffix
    /\bx\s+\w+\s+x\s+\w+/i,  // "X something X something" pattern
  ];
  
  for (const pattern of hentaiPatterns) {
    if (pattern.test(anime.name) && confidence < 30) {
      // Low confidence trigger - only flag if other signals exist
      // reasons.push('pattern_match');
      // confidence = Math.max(confidence, 20);
    }
  }
  
  return {
    isNSFW: confidence >= 95, // Only flag with very high confidence
    confidence,
    reasons
  };
}

function filterCatalog(animeCatalog, hentaiLookup, hentaiCatalog, dryRun = false) {
  console.log('\nScanning for NSFW content...');
  
  const nsfw = [];
  const clean = [];
  
  for (const anime of animeCatalog.catalog) {
    const detection = detectNSFW(anime, hentaiLookup, hentaiCatalog);
    
    if (detection.isNSFW) {
      nsfw.push({
        id: anime.id,
        name: anime.name,
        genres: anime.genres,
        studios: anime.studios,
        ...detection
      });
    } else {
      clean.push(anime);
    }
  }
  
  console.log(`\n=== RESULTS ===`);
  console.log(`Total anime: ${animeCatalog.catalog.length}`);
  console.log(`NSFW detected: ${nsfw.length}`);
  console.log(`Clean entries: ${clean.length}`);
  
  // Sort NSFW by confidence
  nsfw.sort((a, b) => b.confidence - a.confidence);
  
  // Show sample of detected NSFW
  console.log(`\n=== TOP 20 NSFW DETECTIONS ===`);
  nsfw.slice(0, 20).forEach((item, i) => {
    console.log(`${i + 1}. [${item.confidence}%] ${item.name}`);
    console.log(`   Reasons: ${item.reasons.join(', ')}`);
  });
  
  // Group by detection method
  const byMethod = {};
  for (const item of nsfw) {
    for (const reason of item.reasons) {
      const method = reason.split(':')[0];
      byMethod[method] = (byMethod[method] || 0) + 1;
    }
  }
  
  console.log(`\n=== DETECTION METHODS ===`);
  Object.entries(byMethod).sort((a, b) => b[1] - a[1]).forEach(([method, count]) => {
    console.log(`  ${method}: ${count}`);
  });
  
  if (!dryRun) {
    // Save filtered catalog
    const filtered = {
      ...animeCatalog,
      catalog: clean,
      totalCount: clean.length,
      nsfwFiltered: nsfw.length
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filtered, null, 2));
    console.log(`\nSaved filtered catalog to: ${OUTPUT_PATH}`);
    
    // Save NSFW report
    const report = {
      generatedAt: new Date().toISOString(),
      totalScanned: animeCatalog.catalog.length,
      nsfwCount: nsfw.length,
      cleanCount: clean.length,
      byMethod,
      nsfwEntries: nsfw
    };
    fs.writeFileSync(NSFW_REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`Saved NSFW report to: ${NSFW_REPORT_PATH}`);
  }
  
  return { nsfw, clean };
}

// ===== MAIN =====

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

if (dryRun) {
  console.log('=== DRY RUN MODE (no files will be modified) ===\n');
}

try {
  const { animeCatalog, hentaiCatalog } = loadCatalogs();
  const hentaiLookup = buildHentaiLookup(hentaiCatalog);
  const { nsfw, clean } = filterCatalog(animeCatalog, hentaiLookup, hentaiCatalog, dryRun);
  
  if (verbose) {
    console.log('\n=== ALL NSFW DETECTIONS ===');
    nsfw.forEach((item, i) => {
      console.log(`${i + 1}. [${item.confidence}%] ${item.name} (${item.id})`);
      console.log(`   Reasons: ${item.reasons.join(', ')}`);
    });
  }
  
  console.log('\n✓ Done!');
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
