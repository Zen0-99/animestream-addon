// Debug script to trace handleAiring filtering logic locally

const catalog = require('./data/catalog.json').catalog;

// Copy all the filter functions from worker
const HIDDEN_DUPLICATE_ENTRIES = new Set(['tt36956670', 'tt14331144', 'mal-57658']);
const SEASON_TO_PARENT_MAP = {
  'mal-57658': 'tt12343534',
  'tt36956670': 'tt12343534',
  'tt14331144': 'tt12343534',
};

function isSeriesType(anime) {
  if (anime.subtype === 'movie') return false;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return false;
  return true;
}

function isHiddenDuplicate(anime) {
  return HIDDEN_DUPLICATE_ENTRIES.has(anime.id);
}

function isRecap(anime) {
  const name = (anime.name || '').toLowerCase();
  if (/\brecaps?\b/i.test(name)) return true;
  if (/\bdigest\b/i.test(name) && anime.subtype === 'special') return true;
  return false;
}

function isNonAnime(anime) {
  // Simplified - just check if starts with known non-anime prefixes
  return false;
}

function isMusicVideo(anime) {
  return anime.subtype === 'music';
}

function isDeletedEntry(anime) {
  const name = (anime.name || '').toLowerCase().trim();
  return /^delete/i.test(name);
}

function isOVA(anime) {
  return anime.subtype === 'OVA';
}

function shouldExcludeFromCatalog(anime) {
  if (isHiddenDuplicate(anime)) return true;
  if (isNonAnime(anime)) return true;
  if (isRecap(anime)) return true;
  if (isMusicVideo(anime)) return true;
  if (isDeletedEntry(anime)) return true;
  if (isOVA(anime)) return true;
  return false;
}

function getParentsWithOngoingSeasons(catalogData) {
  const ongoingParents = new Set();
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId) {
        ongoingParents.add(parentId);
      }
    }
  }
  return ongoingParents;
}

// Get all ONGOING Friday anime
const ongoingFriday = catalog.filter(a => a.status === 'ONGOING' && a.broadcastDay === 'Friday');
console.log(`\n=== Total ONGOING Friday anime: ${ongoingFriday.length} ===`);

// Test each one through the filters
ongoingFriday.forEach(anime => {
  const seriesType = isSeriesType(anime);
  const excluded = shouldExcludeFromCatalog(anime);
  const passed = seriesType && !excluded;
  
  console.log(`\n${anime.id} - ${anime.name}`);
  console.log(`  isSeriesType: ${seriesType}`);
  console.log(`  shouldExclude: ${excluded}`);
  if (excluded) {
    console.log(`    - isHiddenDuplicate: ${isHiddenDuplicate(anime)}`);
    console.log(`    - isOVA: ${isOVA(anime)}`);
    console.log(`    - isRecap: ${isRecap(anime)}`);
    console.log(`    - isMusicVideo: ${isMusicVideo(anime)}`);
  }
  console.log(`  PASSED FILTER: ${passed ? '✓' : '✗'}`);
});

// Count how many pass
const passed = ongoingFriday.filter(a => isSeriesType(a) && !shouldExcludeFromCatalog(a));
console.log(`\n=== ${passed.length} passed the filters ===`);
passed.forEach(a => console.log(`  ${a.id} - ${a.name}`));
