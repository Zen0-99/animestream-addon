#!/usr/bin/env node

/**
 * Bulk Database Enrichment Script
 * 
 * Enriches ALL anime in the catalog.json with missing metadata from:
 * - Kitsu (posters, covers, descriptions)
 * - MyAnimeList via Jikan API (ratings, genres, cast)
 * 
 * NOTE: Does NOT override Cinemeta-provided data. Cinemeta is fetched at runtime
 * by the worker, so we only fill gaps for anime that Cinemeta doesn't cover.
 * 
 * Usage:
 *   node scripts/bulk-enrich-database.js                    # Full run
 *   node scripts/bulk-enrich-database.js --dry-run          # Preview changes
 *   node scripts/bulk-enrich-database.js --start=1000       # Start from index 1000
 *   node scripts/bulk-enrich-database.js --limit=500        # Process only 500 anime
 *   node scripts/bulk-enrich-database.js --missing-only     # Only process anime with missing data
 *   node scripts/bulk-enrich-database.js --verbose          # Show detailed output
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');

// Parse command line args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const MISSING_ONLY = args.includes('--missing-only');
const START_ARG = args.find(a => a.startsWith('--start='));
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const START_INDEX = START_ARG ? parseInt(START_ARG.split('=')[1]) : 0;
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1]) : null;

// Rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Track statistics
const stats = {
  processed: 0,
  enriched: 0,
  postersFixed: 0,
  descriptionsFixed: 0,
  ratingsFixed: 0,
  genresFixed: 0,
  runtimesFixed: 0,
  backgroundsFixed: 0,
  skipped: 0,
  errors: 0
};

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { ...options, timeout: 15000 });
      if (response.status === 429) {
        // Rate limited - wait longer
        console.log(`\n  ⚠ Rate limited, waiting 5s...`);
        await delay(5000);
        continue;
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1));
    }
  }
}

async function checkPosterUrl(url) {
  if (!url) return false;
  try {
    const response = await fetch(url, { method: 'HEAD', timeout: 5000 });
    return response.ok;
  } catch {
    return false;
  }
}

function isMissingMetadata(anime) {
  const issues = [];
  
  if (!anime.poster) issues.push('poster');
  if (!anime.description || anime.description.length < 50) issues.push('description');
  if (!anime.rating && !anime.imdbRating) issues.push('rating');
  if (!anime.genres || anime.genres.length === 0) issues.push('genres');
  if (!anime.runtime) issues.push('runtime');
  if (!anime.background) issues.push('background');
  
  return issues;
}

// ========== Data Source Fetchers ==========

async function fetchKitsu(animeName, malId = null) {
  try {
    // Clean name for search
    const searchName = animeName
      .replace(/\s*\(TV\)$/i, '')
      .replace(/\s*Season\s*\d+$/i, '')
      .replace(/\s*\d+(st|nd|rd|th)\s+Season$/i, '')
      .trim();
    
    const response = await fetchWithRetry(
      `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchName)}&include=genres,categories`
    );
    if (!response || !response.ok) return null;
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      // Try to find best match
      const normalizedSearch = searchName.toLowerCase().replace(/[^a-z0-9]/g, '');
      let bestMatch = data.data[0];
      let bestScore = 0;
      
      for (const anime of data.data.slice(0, 5)) {
        const attrs = anime.attributes;
        const titles = [
          attrs.canonicalTitle,
          attrs.titles?.en,
          attrs.titles?.en_jp,
          attrs.titles?.ja_jp
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
      
      const attrs = bestMatch.attributes;
      
      // Extract genres from included
      let genres = [];
      if (data.included) {
        genres = data.included
          .filter(inc => inc.type === 'genres' || inc.type === 'categories')
          .map(inc => inc.attributes.name || inc.attributes.title)
          .filter(Boolean);
      }
      
      return {
        poster: attrs.posterImage?.large || attrs.posterImage?.original,
        cover: attrs.coverImage?.large || attrs.coverImage?.original,
        description: attrs.synopsis,
        rating: attrs.averageRating ? parseFloat(attrs.averageRating) / 10 : null, // Kitsu uses 0-100
        runtime: attrs.episodeLength ? `${attrs.episodeLength} min` : null,
        genres: genres.length > 0 ? genres : null,
        matchScore: bestScore
      };
    }
    return null;
  } catch (e) {
    if (VERBOSE) console.log(`\n    Kitsu error: ${e.message}`);
    return null;
  }
}

async function fetchMAL(animeName) {
  try {
    const searchName = animeName
      .replace(/\s*\(TV\)$/i, '')
      .replace(/\s*Season\s*\d+$/i, '')
      .replace(/\s*\d+(st|nd|rd|th)\s+Season$/i, '')
      .trim();
    
    const response = await fetchWithRetry(
      `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchName)}&limit=3`
    );
    if (!response || !response.ok) return null;
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      const normalizedSearch = searchName.toLowerCase().replace(/[^a-z0-9]/g, '');
      let bestMatch = data.data[0];
      let bestScore = 0;
      
      for (const anime of data.data) {
        const titles = [
          anime.title,
          anime.title_english,
          anime.title_japanese,
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
      
      // Parse duration
      let runtime = null;
      if (bestMatch.duration) {
        const match = bestMatch.duration.match(/(\d+)\s*min/i);
        if (match) runtime = `${match[1]} min`;
      }
      
      // Combine genres and themes
      const allGenres = [
        ...(bestMatch.genres?.map(g => g.name) || []),
        ...(bestMatch.themes?.map(t => t.name) || [])
      ];
      
      return {
        mal_id: bestMatch.mal_id,
        title: bestMatch.title,
        poster: bestMatch.images?.jpg?.large_image_url,
        description: bestMatch.synopsis?.replace(/\[Written by MAL Rewrite\]/g, '').replace(/\(Source:.*?\)/g, '').trim(),
        rating: bestMatch.score,
        runtime: runtime,
        genres: allGenres.length > 0 ? [...new Set(allGenres)].slice(0, 8) : null,
        matchScore: bestScore
      };
    }
    return null;
  } catch (e) {
    if (VERBOSE) console.log(`\n    MAL error: ${e.message}`);
    return null;
  }
}

// ========== Enrichment Logic ==========

async function enrichAnime(anime) {
  const missingFields = isMissingMetadata(anime);
  if (missingFields.length === 0) return null;
  
  const enrichment = {};
  let changed = false;
  
  // Fetch data from sources
  // Kitsu first (no rate limit issues)
  const kitsu = await fetchKitsu(anime.name);
  await delay(300); // Small delay between requests
  
  // MAL with rate limiting (Jikan API: 3 req/sec)
  await delay(400);
  const mal = await fetchMAL(anime.name);
  
  if (VERBOSE && (kitsu || mal)) {
    console.log(`\n    Sources found: ${kitsu ? 'Kitsu' : ''}${kitsu && mal ? ', ' : ''}${mal ? 'MAL' : ''}`);
  }
  
  // Enrich poster (priority: Kitsu > MAL - Kitsu has better quality)
  if (missingFields.includes('poster')) {
    let newPoster = null;
    
    if (kitsu?.poster) {
      const isValid = await checkPosterUrl(kitsu.poster);
      if (isValid) newPoster = kitsu.poster;
    }
    
    if (!newPoster && mal?.poster) {
      const isValid = await checkPosterUrl(mal.poster);
      if (isValid) newPoster = mal.poster;
    }
    
    if (newPoster) {
      enrichment.poster = newPoster;
      stats.postersFixed++;
      changed = true;
    }
  }
  
  // Enrich description (priority: MAL > Kitsu - MAL has better descriptions)
  if (missingFields.includes('description')) {
    if (mal?.description && mal.description.length > 50) {
      enrichment.description = mal.description;
      stats.descriptionsFixed++;
      changed = true;
    } else if (kitsu?.description && kitsu.description.length > 50) {
      enrichment.description = kitsu.description;
      stats.descriptionsFixed++;
      changed = true;
    }
  }
  
  // Enrich rating (priority: MAL - industry standard for anime ratings)
  if (missingFields.includes('rating')) {
    if (mal?.rating && mal.rating > 0) {
      enrichment.rating = mal.rating;
      stats.ratingsFixed++;
      changed = true;
    } else if (kitsu?.rating && kitsu.rating > 0) {
      enrichment.rating = kitsu.rating;
      stats.ratingsFixed++;
      changed = true;
    }
  }
  
  // Enrich genres
  if (missingFields.includes('genres')) {
    if (mal?.genres && mal.genres.length > 0) {
      enrichment.genres = mal.genres;
      stats.genresFixed++;
      changed = true;
    } else if (kitsu?.genres && kitsu.genres.length > 0) {
      enrichment.genres = kitsu.genres;
      stats.genresFixed++;
      changed = true;
    }
  }
  
  // Enrich runtime
  if (missingFields.includes('runtime')) {
    if (mal?.runtime) {
      enrichment.runtime = mal.runtime;
      stats.runtimesFixed++;
      changed = true;
    } else if (kitsu?.runtime) {
      enrichment.runtime = kitsu.runtime;
      stats.runtimesFixed++;
      changed = true;
    }
  }
  
  // Enrich background
  if (missingFields.includes('background')) {
    if (kitsu?.cover) {
      const isValid = await checkPosterUrl(kitsu.cover);
      if (isValid) {
        enrichment.background = kitsu.cover;
        stats.backgroundsFixed++;
        changed = true;
      }
    }
  }
  
  return changed ? enrichment : null;
}

// ========== Main ==========

async function main() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Bulk Database Enrichment');
  console.log('════════════════════════════════════════════════════════════\n');
  
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (preview only)' : 'APPLY CHANGES'}`);
  if (MISSING_ONLY) console.log('Filter: Missing metadata only');
  if (START_INDEX > 0) console.log(`Start: Index ${START_INDEX}`);
  if (LIMIT) console.log(`Limit: ${LIMIT} anime`);
  console.log('');
  
  // Load catalog (structure: { buildDate, version, source, stats, catalog: [...] })
  console.log('Loading catalog...');
  const catalogData = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const catalog = catalogData.catalog;
  console.log(`  Loaded ${catalog.length} anime\n`);
  
  // Filter and slice based on args
  let toProcess = catalog;
  
  if (MISSING_ONLY) {
    toProcess = catalog.filter(a => isMissingMetadata(a).length > 0);
    console.log(`  ${toProcess.length} anime have missing metadata\n`);
  }
  
  // Apply start and limit
  if (START_INDEX > 0) {
    toProcess = toProcess.slice(START_INDEX);
  }
  if (LIMIT) {
    toProcess = toProcess.slice(0, LIMIT);
  }
  
  console.log(`Processing ${toProcess.length} anime...\n`);
  console.log('(This will take a while due to API rate limiting)\n');
  
  const startTime = Date.now();
  
  for (let i = 0; i < toProcess.length; i++) {
    const anime = toProcess[i];
    const originalIndex = catalog.indexOf(anime);
    
    // Progress display
    const progress = ((i + 1) / toProcess.length * 100).toFixed(1);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const rate = i > 0 ? (elapsed / i) : 0;
    const eta = Math.floor(rate * (toProcess.length - i - 1));
    
    process.stdout.write(`\r[${progress}%] ${i + 1}/${toProcess.length} | Enriched: ${stats.enriched} | ETA: ${Math.floor(eta/60)}m${eta%60}s | ${anime.name.substring(0, 30).padEnd(30)}...`);
    
    try {
      stats.processed++;
      
      // Check if already complete
      const missing = isMissingMetadata(anime);
      if (missing.length === 0) {
        stats.skipped++;
        continue;
      }
      
      // Enrich
      const enrichment = await enrichAnime(anime);
      
      if (enrichment && Object.keys(enrichment).length > 0) {
        stats.enriched++;
        
        if (VERBOSE) {
          console.log(`\n  ✓ ${anime.name}: ${Object.keys(enrichment).join(', ')}`);
        }
        
        // Apply enrichment to catalog
        if (!DRY_RUN) {
          Object.assign(catalog[originalIndex], enrichment);
        }
      }
      
    } catch (error) {
      stats.errors++;
      if (VERBOSE) {
        console.log(`\n  ✗ Error for ${anime.name}: ${error.message}`);
      }
    }
    
    // Rate limiting between anime
    await delay(300);
  }
  
  console.log('\n\n');
  
  // Save catalog if not dry run
  if (!DRY_RUN && stats.enriched > 0) {
    console.log('Saving catalog...');
    catalogData.catalog = catalog;
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalogData, null, 2));
    console.log(`  ✓ Saved catalog: ${catalog.length} anime\n`);
  } else if (DRY_RUN) {
    console.log('DRY RUN - no changes saved\n');
  }
  
  // Print summary
  const duration = Math.floor((Date.now() - startTime) / 1000);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('════════════════════════════════════════════════════════════\n');
  console.log(`  Processed: ${stats.processed}`);
  console.log(`  Enriched: ${stats.enriched}`);
  console.log(`  Skipped (complete): ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log('');
  console.log('  Fixes by field:');
  console.log(`    - Posters: ${stats.postersFixed}`);
  console.log(`    - Descriptions: ${stats.descriptionsFixed}`);
  console.log(`    - Ratings: ${stats.ratingsFixed}`);
  console.log(`    - Genres: ${stats.genresFixed}`);
  console.log(`    - Runtimes: ${stats.runtimesFixed}`);
  console.log(`    - Backgrounds: ${stats.backgroundsFixed}`);
  console.log('');
  console.log(`  Duration: ${Math.floor(duration/60)}m ${duration%60}s`);
  console.log('');
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
