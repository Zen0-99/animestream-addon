/**
 * Fetch current season anime from Jikan and update catalog.
 * Uses Jikan's /seasons/{year}/{season} endpoint for efficient season fetching.
 * Also updates airing status for existing anime.
 *
 * Usage: node scripts/fetch-season.js
 */

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const JIKAN_BASE = 'https://api.jikan.moe/v4';
const RATE_LIMIT = 1200; // Jikan free tier: ~1 req/sec (be conservative)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  let season;
  if (month >= 0 && month <= 2) season = 'winter';
  else if (month >= 3 && month <= 5) season = 'spring';
  else if (month >= 6 && month <= 8) season = 'summer';
  else season = 'fall';
  return { season, year, display: `${year} - ${season.charAt(0).toUpperCase() + season.slice(1)}` };
}

async function fetchWithRetry(url, maxRetries = 8) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (response.status === 429) {
        const wait = 3000 * Math.pow(2, Math.min(attempt, 5));
        console.log(`  Rate limited, waiting ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      if (response.status === 504 || response.status === 502 || response.status === 503) {
        const wait = 5000 * (attempt + 1);
        console.log(`  Server error ${response.status}, retrying in ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = 3000 * (attempt + 1);
      console.log(`  Error: ${err.message}, retrying in ${wait/1000}s...`);
      await sleep(wait);
    }
  }
  throw new Error('Max retries exceeded');
}

async function fetchSeasonAnimeFromAniList(year, season) {
  console.log(`Fetching ${season} ${year} anime from AniList...`);
  const allAnime = [];
  const seasonMap = { winter: 'WINTER', spring: 'SPRING', summer: 'SUMMER', fall: 'FALL' };
  const anilistSeason = seasonMap[season.toLowerCase()];

  const query = `
    query ($season: MediaSeason, $seasonYear: Int, $page: Int) {
      Page(page: $page, perPage: 50) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME, isAdult: false) {
          id
          idMal
          title { romaji english native }
          episodes
          duration
          status
          season
          seasonYear
          format
          averageScore
          popularity
          genres
          countryOfOrigin
          startDate { year month day }
          nextAiringEpisode { airingAt episode }
          description
          coverImage { large extraLarge }
        }
        pageInfo { hasNextPage currentPage lastPage }
      }
    }
  `;

  let page = 1;
  while (true) {
    const variables = { season: anilistSeason, seasonYear: year, page };
    console.log(`  AniList page ${page}...`);
    await sleep(800); // AniList rate limit: ~90 req/min

    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables })
    });

    if (response.status === 429) {
      console.log('  Rate limited, waiting 5s...');
      await sleep(5000);
      continue;
    }

    if (!response.ok) {
      console.log(`  AniList error: HTTP ${response.status}`);
      break;
    }

    const data = await response.json();
    if (data.errors) {
      console.log(`  AniList GraphQL errors: ${data.errors[0]?.message}`);
      break;
    }

    const media = data.data?.Page?.media || [];
    if (media.length === 0) break;

    // Filter to TV, ONA, and movies only
    const filtered = media.filter(a =>
      ['TV', 'ONA', 'MOVIE', 'OVA'].includes(a.format) &&
      a.startDate?.year // Must have a start date
    );
    allAnime.push(...filtered);
    console.log(`    Got ${media.length} entries (${filtered.length} valid), total: ${allAnime.length}`);

    if (!data.data?.Page?.pageInfo?.hasNextPage) break;
    page++;
  }

  return allAnime;
}

function anilistToCatalogEntry(anilistAnime) {
  const statusMap = {
    'RELEASING': 'ONGOING',
    'FINISHED': 'FINISHED',
    'NOT_YET_RELEASED': 'UPCOMING',
    'CANCELLED': 'FINISHED'
  };

  const formatMap = {
    'TV': 'TV',
    'TV_SHORT': 'TV',
    'ONA': 'ONA',
    'OVA': 'OVA',
    'MOVIE': 'MOVIE',
    'SPECIAL': 'SPECIAL',
    'MUSIC': 'MUSIC'
  };

  const name = anilistAnime.title?.english || anilistAnime.title?.romaji || 'Unknown';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Determine broadcast day from nextAiringEpisode airing time
  let broadcastDay = null;
  if (anilistAnime.nextAiringEpisode?.airingAt) {
    const airingDate = new Date(anilistAnime.nextAiringEpisode.airingAt * 1000);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    broadcastDay = days[airingDate.getDay()];
  }

  return {
    id: anilistAnime.idMal ? `mal-${anilistAnime.idMal}` : `al-${anilistAnime.id}`,
    imdb_id: null,
    kitsu_id: null,
    mal_id: anilistAnime.idMal || null,
    anilist_id: anilistAnime.id,
    anidb_id: null,
    type: anilistAnime.format === 'MOVIE' ? 'movie' : 'series',
    name,
    slug,
    description: (anilistAnime.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
    year: anilistAnime.seasonYear || anilistAnime.startDate?.year || null,
    season: anilistAnime.season || null,
    status: statusMap[anilistAnime.status] || 'UNKNOWN',
    rating: anilistAnime.averageScore ? anilistAnime.averageScore / 10 : null,
    poster: anilistAnime.coverImage?.extraLarge || anilistAnime.coverImage?.large || null,
    background: anilistAnime.coverImage?.extraLarge || null,
    logo: null,
    cast: [],
    genres: anilistAnime.genres || [],
    episodeCount: anilistAnime.episodes || null,
    runtime: anilistAnime.duration ? `${anilistAnime.duration} min` : null,
    ageRating: null,
    subtype: formatMap[anilistAnime.format] || 'TV',
    popularity: anilistAnime.popularity || null,
    synonyms: [anilistAnime.title?.romaji, anilistAnime.title?.native].filter(Boolean),
    broadcastDay,
    countryOfOrigin: anilistAnime.countryOfOrigin || 'JP'
  };
}

async function fetchSeasonAnime(year, season) {
  // Try AniList first (more reliable, better rate limits)
  try {
    const anilistResults = await fetchSeasonAnimeFromAniList(year, season);
    if (anilistResults.length > 0) {
      return anilistResults.map(anilistToCatalogEntry);
    }
  } catch (err) {
    console.log(`AniList fetch failed: ${err.message}, falling back to Jikan...`);
  }

  // Fallback to Jikan
  console.log(`Fetching ${season} ${year} anime from Jikan...`);
  const allAnime = [];
  let page = 1;

  while (true) {
    const url = `${JIKAN_BASE}/seasons/${year}/${season}?page=${page}&sfw=true`;
    console.log(`  Jikan page ${page}...`);
    await sleep(RATE_LIMIT);
    const data = await fetchWithRetry(url);

    if (!data.data || data.data.length === 0) break;

    const filtered = data.data.filter(a =>
      ['tv', 'ona', 'movie', 'ova'].includes((a.type || '').toLowerCase()) &&
      a.aired?.from
    );
    allAnime.push(...filtered);
    console.log(`    Got ${data.data.length} entries (${filtered.length} valid), total: ${allAnime.length}`);

    if (!data.pagination?.has_next_page) break;
    page++;
  }

  // Convert Jikan format to catalog entries
  return allAnime.map(jikanToCatalogEntry);
}

async function fetchCurrentlyAiringFromAniList() {
  console.log(`Fetching currently airing anime from AniList...`);
  const allAnime = [];
  let page = 1;

  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        media(status: RELEASING, type: ANIME, isAdult: false) {
          id
          idMal
          title { romaji english native }
          status
          episodes
          nextAiringEpisode { airingAt episode }
          season
          seasonYear
          startDate { year month day }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  while (page <= 20) {
    console.log(`  AniList airing page ${page}...`);
    await sleep(800);
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { page } })
    });

    if (response.status === 429) {
      console.log('  Rate limited, waiting 5s...');
      await sleep(5000);
      continue;
    }

    if (!response.ok) {
      console.log(`  AniList error: HTTP ${response.status}`);
      break;
    }

    const data = await response.json();
    if (data.errors) break;

    const media = data.data?.Page?.media || [];
    if (media.length === 0) break;

    allAnime.push(...media);
    console.log(`    Got ${media.length} anime (total: ${allAnime.length})`);

    if (!data.data?.Page?.pageInfo?.hasNextPage) break;
    page++;
  }

  return allAnime;
}

function jikanToCatalogEntry(jikanAnime) {
  let season = null;
  let year = null;

  if (jikanAnime.aired?.from) {
    const date = new Date(jikanAnime.aired.from);
    year = date.getFullYear();
    const month = date.getMonth();
    if (month >= 0 && month <= 2) season = 'WINTER';
    else if (month >= 3 && month <= 5) season = 'SPRING';
    else if (month >= 6 && month <= 8) season = 'SUMMER';
    else season = 'FALL';
  }

  const statusMap = {
    'Currently Airing': 'ONGOING',
    'Finished Airing': 'FINISHED',
    'Not yet aired': 'UPCOMING'
  };

  let broadcastDay = null;
  if (jikanAnime.broadcast?.day) {
    const dayMap = {
      'mondays': 'Monday', 'tuesdays': 'Tuesday', 'wednesdays': 'Wednesday',
      'thursdays': 'Thursday', 'fridays': 'Friday', 'saturdays': 'Saturday',
      'sundays': 'Sunday'
    };
    broadcastDay = dayMap[jikanAnime.broadcast.day.toLowerCase()] || null;
  }

  const genres = [
    ...(jikanAnime.genres || []).map(g => g.name),
    ...(jikanAnime.themes || []).map(t => t.name)
  ];

  return {
    id: `mal-${jikanAnime.mal_id}`,
    imdb_id: null,
    kitsu_id: null,
    mal_id: jikanAnime.mal_id,
    anilist_id: null,
    anidb_id: null,
    type: jikanAnime.type === 'movie' ? 'movie' : 'series',
    name: jikanAnime.title_english || jikanAnime.title,
    slug: (jikanAnime.title_english || jikanAnime.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    description: jikanAnime.synopsis || '',
    year,
    season,
    status: statusMap[jikanAnime.status] || 'UNKNOWN',
    rating: jikanAnime.score || null,
    poster: jikanAnime.images?.jpg?.large_image_url || null,
    background: jikanAnime.images?.jpg?.large_image_url || null,
    logo: null,
    cast: [],
    genres: [...new Set(genres)],
    episodeCount: jikanAnime.episodes || null,
    runtime: jikanAnime.duration || null,
    ageRating: jikanAnime.rating || null,
    subtype: (jikanAnime.type || 'TV').toUpperCase(),
    popularity: jikanAnime.popularity || null,
    synonyms: [jikanAnime.title, jikanAnime.title_japanese].filter(Boolean),
    broadcastDay,
    countryOfOrigin: 'JP' // Default, will be enriched later
  };
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  Fetch Current Season Anime');
  console.log('═'.repeat(60));

  const currentSeason = getCurrentSeason();
  console.log(`Current season: ${currentSeason.display}\n`);

  // Load catalog
  console.log('Loading catalog...');
  const catalogData = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const catalog = catalogData.catalog || catalogData;
  const isWrapped = !!catalogData.catalog;
  console.log(`Catalog: ${catalog.length} anime\n`);

  // Build set of existing MAL IDs
  const existingMalIds = new Set(catalog.filter(a => a.mal_id).map(a => a.mal_id));

  // 1. Fetch current season anime (returns catalog entries)
  const seasonEntries = await fetchSeasonAnime(currentSeason.year, currentSeason.season);
  console.log(`\nFetched ${seasonEntries.length} anime for ${currentSeason.display}\n`);

  // 2. Fetch currently airing anime from AniList (for status updates)
  const airingAnime = await fetchCurrentlyAiringFromAniList();
  console.log(`\nFetched ${airingAnime.length} currently airing anime\n`);

  // 3. Add new anime from current season
  let added = 0;
  const newEntries = [];
  for (const entry of seasonEntries) {
    const existingId = entry.mal_id ? existingMalIds.has(entry.mal_id) : false;
    const existingById = catalog.find(a => a.id === entry.id);
    if (!existingId && !existingById) {
      newEntries.push(entry);
      if (entry.mal_id) existingMalIds.add(entry.mal_id);
      added++;
      console.log(`  NEW: ${entry.name} (${entry.id}) - ${entry.status} - ${entry.season} ${entry.year}`);
    }
  }

  // 4. Update status for existing anime using AniList airing data
  let statusUpdated = 0;
  let broadcastUpdated = 0;

  // Build maps of airing anime by MAL ID and AniList ID
  const airingByMalId = new Map();
  const airingByAnilistId = new Map();
  for (const a of airingAnime) {
    if (a.idMal) airingByMalId.set(a.idMal, a);
    airingByAnilistId.set(a.id, a);
  }

  for (const anime of catalog) {
    // Match by MAL ID or AniList ID
    let airingData = null;
    if (anime.mal_id && airingByMalId.has(anime.mal_id)) {
      airingData = airingByMalId.get(anime.mal_id);
    } else if (anime.anilist_id && airingByAnilistId.has(anime.anilist_id)) {
      airingData = airingByAnilistId.get(anime.anilist_id);
    }

    if (airingData) {
      // This anime is currently airing - update status and broadcast day
      if (anime.status !== 'ONGOING') {
        anime.status = 'ONGOING';
        statusUpdated++;
      }

      // Update broadcast day from nextAiringEpisode
      if (airingData.nextAiringEpisode?.airingAt) {
        const airingDate = new Date(airingData.nextAiringEpisode.airingAt * 1000);
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const newDay = days[airingDate.getDay()];
        if (newDay && newDay !== anime.broadcastDay) {
          anime.broadcastDay = newDay;
          broadcastUpdated++;
        }
      }

      // Update episode count if available
      if (airingData.episodes && airingData.episodes !== anime.episodeCount) {
        anime.episodeCount = airingData.episodes;
        anime.episodes = airingData.episodes;
      }

      // Update season/year if missing
      if ((!anime.season || !anime.year) && airingData.startDate?.year) {
        anime.year = anime.year || airingData.startDate.year;
        if (!anime.season && airingData.season) {
          anime.season = airingData.season.toUpperCase();
        }
      }
    } else if (anime.status === 'ONGOING') {
      // Anime is marked ONGOING but not in AniList's RELEASING list
      // Mark as FINISHED if it's not a long-running show
      const currentYear = new Date().getFullYear();
      const animeYear = anime.year || currentYear;

      // Don't touch long-running shows (pre-2016 with no episode count or 100+ episodes)
      const isLongRunning = (animeYear < currentYear - 10 && (!anime.episodeCount || anime.episodeCount === null)) ||
                            (anime.episodeCount && anime.episodeCount >= 100);
      if (isLongRunning) continue;

      // Don't touch Chinese/Korean anime (they often have different airing patterns)
      if (anime.countryOfOrigin && anime.countryOfOrigin !== 'JP') continue;

      // Mark as FINISHED if not in AniList's airing list
      // Only for shows from 2024 onwards (recent shows that likely finished)
      if (animeYear >= 2024) {
        console.log(`  FINISHED: ${anime.name} (${anime.year}) - not in AniList airing list`);
        anime.status = 'FINISHED';
        statusUpdated++;
      }
    }
  }

  // Add new entries to catalog
  catalog.push(...newEntries);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Summary`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  New anime added: ${added}`);
  console.log(`  Status updates: ${statusUpdated}`);
  console.log(`  Broadcast day updates: ${broadcastUpdated}`);
  console.log(`  Total catalog: ${catalog.length}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Save
  console.log('Saving catalog...');
  const output = isWrapped ? { ...catalogData, catalog } : catalog;
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(output, null, 2));
  console.log('Saved!');

  // Also save gzipped
  const { gzipSync } = require('zlib');
  const gzipped = gzipSync(Buffer.from(JSON.stringify(output)));
  fs.writeFileSync(CATALOG_PATH + '.gz', gzipped);
  console.log(`Saved gzipped (${(gzipped.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
