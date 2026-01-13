#!/usr/bin/env node

/**
 * Add Missing Currently Airing Anime
 * 
 * This script fetches currently airing anime from Jikan API and adds
 * any missing ones to our database. It handles:
 * 1. Anime that exist in anime-offline-database as UPCOMING but are now airing
 * 2. Anime that are completely missing from our catalog
 * 
 * Usage: node scripts/add-missing-airing.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const CATALOG_GZ_PATH = path.join(DATA_DIR, 'catalog.json.gz');
const FILTER_OPTIONS_PATH = path.join(DATA_DIR, 'filter-options.json');
const OFFLINE_DB_PATH = path.join(DATA_DIR, 'anime-offline-database.json');

// Jikan API config
const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';
const JIKAN_RATE_LIMIT_MS = 400;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Specific anime to add (from user's screenshots)
 */
const SPECIFIC_ANIME_TO_ADD = [
  { mal_id: 57658, name: 'Jujutsu Kaisen: Shimetsu Kaiyuu - Zenpen', reason: 'JJK Season 3 - The Culling Game' },
  // Add more here as needed
];

/**
 * Fetch anime data from Jikan API
 */
async function fetchFromJikan(malId) {
  try {
    const url = `${JIKAN_BASE_URL}/anime/${malId}/full`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      console.log(`    Rate limited, waiting 2 seconds...`);
      await sleep(2000);
      return fetchFromJikan(malId);
    }
    
    if (!response.ok) {
      console.log(`    Jikan returned ${response.status} for MAL ${malId}`);
      return null;
    }
    
    const data = await response.json();
    return data.data || null;
  } catch (error) {
    console.error(`    Error fetching MAL ${malId}:`, error.message);
    return null;
  }
}

/**
 * Fetch external IDs for an anime
 */
async function fetchExternalIds(malId) {
  try {
    await sleep(JIKAN_RATE_LIMIT_MS);
    const url = `${JIKAN_BASE_URL}/anime/${malId}/external`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      await sleep(2000);
      return fetchExternalIds(malId);
    }
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}

/**
 * Get Kitsu data for an anime by MAL ID
 */
async function fetchKitsuData(malId) {
  try {
    // First, search by MAL ID mapping
    const url = `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/vnd.api+json' }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data.included || data.included.length === 0) return null;
    
    const kitsuAnime = data.included.find(i => i.type === 'anime');
    return kitsuAnime ? {
      id: parseInt(kitsuAnime.id),
      title: kitsuAnime.attributes.canonicalTitle,
      poster: kitsuAnime.attributes.posterImage?.large || null,
      synopsis: kitsuAnime.attributes.synopsis,
      rating: kitsuAnime.attributes.averageRating ? parseFloat(kitsuAnime.attributes.averageRating) / 10 : null,
    } : null;
  } catch (error) {
    console.log(`    Kitsu error: ${error.message}`);
    return null;
  }
}

/**
 * Convert Jikan status to our format
 */
function convertStatus(jikanStatus) {
  const statusMap = {
    'Currently Airing': 'ONGOING',
    'Finished Airing': 'FINISHED',
    'Not yet aired': 'UPCOMING'
  };
  return statusMap[jikanStatus] || 'FINISHED';
}

/**
 * Normalize weekday
 */
function normalizeWeekday(day) {
  if (!day) return null;
  const normalized = day.toLowerCase().trim();
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const weekday of weekdays) {
    if (normalized.includes(weekday)) {
      return weekday.charAt(0).toUpperCase() + weekday.slice(1);
    }
  }
  return null;
}

/**
 * Extract genres from Jikan data
 */
function extractGenres(jikanData) {
  const genres = [];
  if (jikanData.genres) {
    genres.push(...jikanData.genres.map(g => g.name));
  }
  if (jikanData.themes) {
    genres.push(...jikanData.themes.map(g => g.name));
  }
  // Remove "Animation" as it's redundant
  return genres.filter(g => g.toLowerCase() !== 'animation');
}

/**
 * Create a catalog entry from Jikan + Kitsu data
 */
async function createCatalogEntry(jikanData, kitsuData, imdbId = null) {
  const genres = extractGenres(jikanData);
  const broadcastDay = normalizeWeekday(jikanData.broadcast?.day);
  
  // Get best poster - prefer Kitsu if available
  let poster = kitsuData?.poster || null;
  if (!poster && jikanData.images?.jpg?.large_image_url) {
    poster = jikanData.images.jpg.large_image_url;
  }
  
  // Use Kitsu rating if available (0-10 scale), else use MAL score
  let rating = kitsuData?.rating || null;
  if (!rating && jikanData.score) {
    rating = jikanData.score;
  }
  
  return {
    id: imdbId || `mal-${jikanData.mal_id}`,
    imdb_id: imdbId,
    kitsu_id: kitsuData?.id || null,
    mal_id: jikanData.mal_id,
    name: jikanData.title_english || jikanData.title,
    type: 'series',
    subtype: jikanData.type?.toLowerCase() === 'movie' ? 'movie' : 'series',
    poster: poster,
    description: jikanData.synopsis || kitsuData?.synopsis || '',
    genres: genres,
    year: jikanData.aired?.prop?.from?.year || new Date().getFullYear(),
    rating: rating,
    status: convertStatus(jikanData.status),
    broadcastDay: broadcastDay,
    episodes: jikanData.episodes || null,
    runtime: jikanData.duration ? jikanData.duration.replace(' per ep', '') : null,
    studios: jikanData.studios?.map(s => s.name) || [],
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('ADD MISSING CURRENTLY AIRING ANIME');
  console.log('='.repeat(60));
  console.log();
  
  // Load existing catalog
  console.log('Loading existing catalog...');
  const data = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const catalog = data.catalog;
  console.log(`Loaded ${catalog.length} anime`);
  console.log();
  
  // Track stats
  let added = 0;
  let updated = 0;
  let skipped = 0;
  
  // Process specific anime to add
  console.log('Processing specific anime to add...');
  console.log('-'.repeat(60));
  
  for (const item of SPECIFIC_ANIME_TO_ADD) {
    console.log(`\n[ADD] ${item.name} (MAL: ${item.mal_id})`);
    console.log(`      Reason: ${item.reason}`);
    
    // Check if already in catalog
    const existing = catalog.find(a => a.mal_id === item.mal_id);
    if (existing) {
      console.log(`      Already exists as: ${existing.name} (status: ${existing.status})`);
      
      // Update status if needed
      if (existing.status !== 'ONGOING') {
        console.log(`      Updating status to ONGOING`);
        existing.status = 'ONGOING';
        updated++;
      }
      
      // Get broadcast day if missing
      if (!existing.broadcastDay) {
        await sleep(JIKAN_RATE_LIMIT_MS);
        const jikanData = await fetchFromJikan(item.mal_id);
        if (jikanData?.broadcast?.day) {
          existing.broadcastDay = normalizeWeekday(jikanData.broadcast.day);
          console.log(`      Added broadcast day: ${existing.broadcastDay}`);
        }
      }
      continue;
    }
    
    // Fetch from Jikan
    await sleep(JIKAN_RATE_LIMIT_MS);
    const jikanData = await fetchFromJikan(item.mal_id);
    
    if (!jikanData) {
      console.log(`      Failed to fetch from Jikan`);
      skipped++;
      continue;
    }
    
    console.log(`      Status: ${jikanData.status}`);
    console.log(`      Broadcast: ${jikanData.broadcast?.day || 'N/A'}`);
    
    // Fetch Kitsu data
    await sleep(JIKAN_RATE_LIMIT_MS);
    const kitsuData = await fetchKitsuData(item.mal_id);
    if (kitsuData) {
      console.log(`      Kitsu ID: ${kitsuData.id}`);
    }
    
    // Try to get IMDB ID
    let imdbId = null;
    await sleep(JIKAN_RATE_LIMIT_MS);
    const externalIds = await fetchExternalIds(item.mal_id);
    if (externalIds) {
      const imdbEntry = externalIds.find(e => e.site === 'IMDb');
      if (imdbEntry) {
        imdbId = imdbEntry.url.match(/tt\d+/)?.[0] || null;
        console.log(`      IMDB ID: ${imdbId}`);
      }
    }
    
    // Create catalog entry
    const entry = await createCatalogEntry(jikanData, kitsuData, imdbId);
    
    // Add to catalog
    catalog.push(entry);
    console.log(`      ✓ Added to catalog: ${entry.name}`);
    added++;
  }
  
  // Update filter options with new weekday counts
  console.log('\nUpdating filter options...');
  const filterOptions = JSON.parse(fs.readFileSync(FILTER_OPTIONS_PATH, 'utf8'));
  
  // Count weekdays from ONGOING anime
  const weekdayCounts = {};
  for (const anime of catalog) {
    if (anime.status === 'ONGOING' && anime.broadcastDay) {
      weekdayCounts[anime.broadcastDay] = (weekdayCounts[anime.broadcastDay] || 0) + 1;
    }
  }
  
  // Update filter options
  const weekdayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  filterOptions.weekdays = {
    list: weekdayOrder,
    withCounts: weekdayOrder.map(day => `${day} (${weekdayCounts[day] || 0})`)
  };
  
  fs.writeFileSync(FILTER_OPTIONS_PATH, JSON.stringify(filterOptions, null, 2));
  console.log('✓ Updated filter-options.json');
  
  // Save catalog
  console.log('\nSaving updated catalog...');
  data.lastAiringUpdate = new Date().toISOString();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(data, null, 2));
  console.log(`✓ Saved ${CATALOG_PATH}`);
  
  // Compress
  const compressed = zlib.gzipSync(JSON.stringify(data));
  fs.writeFileSync(CATALOG_GZ_PATH, compressed);
  console.log(`✓ Saved ${CATALOG_GZ_PATH} (${(compressed.length / 1024 / 1024).toFixed(2)} MB)`);
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('COMPLETE!');
  console.log('='.repeat(60));
  console.log(`Added: ${added}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`\nTotal ONGOING: ${catalog.filter(a => a.status === 'ONGOING').length}`);
}

main().catch(console.error);
