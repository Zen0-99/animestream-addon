/**
 * AnimeStream Stremio Addon - Cloudflare Worker (GitHub-backed)
 * 
 * A lightweight serverless Stremio addon that fetches catalog data from GitHub.
 * No embedded data - stays under Cloudflare's 1MB limit easily.
 */

// ===== CONFIGURATION =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data';
const CACHE_TTL = 600; // 10 minutes cache for GitHub data (balance between freshness and performance)

// ===== CONSTANTS =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

const PAGE_SIZE = 100;

// AllAnime API endpoint (direct integration, no separate worker)
const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_BASE = 'https://allanime.to';

// ===== DATA CACHE (in-memory per worker instance) =====
let catalogCache = null;
let filterOptionsCache = null;
let cacheTimestamp = 0;

// ===== ALLANIME API HELPERS =====

// Build headers that mimic a real browser for AllAnime API
function buildBrowserHeaders(referer = null) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': ALLANIME_BASE,
    'Referer': referer || ALLANIME_BASE,
  };
}

/**
 * Decode AllAnime's XOR-encrypted URLs
 * They use hex encoding with XOR key 56 (0x38)
 */
function decryptSourceUrl(input) {
  if (!input) return null;
  if (input.startsWith('http')) return normalizeUrl(input);
  
  const str = input.startsWith('--') ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]+$/.test(str)) return input;
  
  let result = '';
  for (let i = 0; i < str.length; i += 2) {
    const num = parseInt(str.substr(i, 2), 16);
    result += String.fromCharCode(num ^ 56);
  }
  
  if (result.startsWith('/api')) return null;
  return normalizeUrl(result);
}

// Fix double slashes and normalize URLs
function normalizeUrl(url) {
  if (!url) return url;
  // Fix double slashes after domain (but not after protocol)
  return url.replace(/([^:]\/)\/+/g, '$1');
}

// Extract quality from source name or URL
function detectQuality(sourceName, url) {
  const text = `${sourceName} ${url}`.toLowerCase();
  if (/2160p|4k|uhd/i.test(text)) return '4K';
  if (/1080p|fhd|fullhd/i.test(text)) return '1080p';
  if (/720p|hd/i.test(text)) return '720p';
  if (/480p|sd/i.test(text)) return '480p';
  return 'HD';
}

// Strip HTML tags from text
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

// Check if URL is a direct video stream
function isDirectStream(url) {
  if (/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(url)) return true;
  if (/fast4speed\.rsvp/i.test(url)) return true;
  return false;
}

/**
 * Search AllAnime for shows matching a query
 */
async function searchAllAnime(searchQuery, limit = 10) {
  const query = `
    query ($search: SearchInput!, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) {
        edges { _id name englishName nativeName type score status episodeCount }
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          search: { query: searchQuery, allowAdult: false, allowUnknown: false },
          limit,
          page: 1,
          translationType: 'sub',
          countryOrigin: 'JP',
        },
      }),
    });

    if (!response.ok) return [];
    
    const data = await response.json();
    const shows = data?.data?.shows?.edges || [];
    
    return shows.map(show => ({
      id: show._id,
      title: show.englishName || show.name,
      nativeTitle: show.nativeName,
      type: show.type,
      score: show.score,
    }));
  } catch (e) {
    console.error('AllAnime search error:', e.message);
    return [];
  }
}

/**
 * Get episode sources from AllAnime
 */
async function getEpisodeSources(showId, episode) {
  const query = `
    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
      episode(showId: $showId, translationType: $translationType, episodeString: $episodeString) {
        episodeString
        sourceUrls
      }
    }
  `;

  const streams = [];

  for (const translationType of ['sub', 'dub']) {
    try {
      const response = await fetch(ALLANIME_API, {
        method: 'POST',
        headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { showId, translationType, episodeString: String(episode) },
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const episodeData = data?.data?.episode;
      if (!episodeData?.sourceUrls) continue;

      for (const source of episodeData.sourceUrls) {
        if (!source.sourceUrl) continue;

        const decodedUrl = decryptSourceUrl(source.sourceUrl);
        if (!decodedUrl || !decodedUrl.startsWith('http')) continue;
        if (decodedUrl.includes('listeamed.net')) continue;

        const isDirect = isDirectStream(decodedUrl);
        
        // Only include direct streams for now (Stremio can play these)
        if (!isDirect) continue;

        streams.push({
          url: decodedUrl,
          quality: detectQuality(source.sourceName, decodedUrl),
          provider: source.sourceName || 'AllAnime',
          type: translationType.toUpperCase(),
          isDirect: true,
          behaviorHints: decodedUrl.includes('fast4speed') ? {
            notWebReady: true,
            bingeGroup: `allanime-${showId}`,
            proxyHeaders: { request: { 'Referer': 'https://allanime.to/' } }
          } : undefined,
        });
      }
    } catch (e) {
      console.error(`Error fetching ${translationType}:`, e.message);
    }
  }

  return streams;
}

// ===== ALLANIME SHOW DETAILS =====

/**
 * Get full show details from AllAnime including available episodes
 */
async function getAllAnimeShowDetails(showId) {
  const query = `
    query ($showId: String!) {
      show(_id: $showId) {
        _id
        name
        englishName
        nativeName
        description
        type
        status
        score
        episodeCount
        thumbnail
        banner
        genres
        studios
        availableEpisodesDetail
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { showId } }),
    });

    if (!response.ok) return null;
    
    const data = await response.json();
    return data?.data?.show || null;
  } catch (e) {
    console.error('AllAnime show details error:', e.message);
    return null;
  }
}

// ===== CINEMETA FALLBACK =====

/**
 * Fetch anime metadata from Cinemeta when not in our catalog
 * This allows us to provide streams for anime that users find via other addons
 * Returns full metadata including poster, description, etc.
 */
async function fetchCinemetaMeta(imdbId, type = 'series') {
  try {
    const cinemetaType = type === 'movie' ? 'movie' : 'series';
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`, {
      headers: buildBrowserHeaders()
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.meta?.name) return null;
    
    const meta = data.meta;
    
    // Return full metadata that might be useful
    return {
      id: imdbId,
      name: meta.name,
      type: cinemetaType,
      poster: meta.poster || null,
      background: meta.background || null,
      description: meta.description || null,
      genres: meta.genres || [],
      releaseInfo: meta.releaseInfo || null,
      runtime: meta.runtime || null,
      videos: meta.videos || [],
      // Flag to indicate if metadata is incomplete
      _hasPoster: !!meta.poster,
      _hasDescription: !!meta.description && meta.description.length > 10,
      _isComplete: !!meta.poster && !!meta.description && meta.description.length > 10
    };
  } catch (e) {
    console.error('Cinemeta fetch error:', e.message);
    return null;
  }
}

/**
 * Check if metadata is poor/incomplete and needs enrichment
 */
function isMetadataIncomplete(meta) {
  if (!meta) return true;
  // Consider incomplete if missing poster or has very short/no description
  return !meta.poster || !meta.description || meta.description.length < 20;
}

// ===== DATA FETCHING =====

async function fetchCatalogData() {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (catalogCache && filterOptionsCache && (now - cacheTimestamp) < CACHE_TTL * 1000) {
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }
  
  try {
    // Fetch both files in parallel
    const [catalogRes, filterRes] = await Promise.all([
      fetch(`${GITHUB_RAW_BASE}/catalog.json`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      }),
      fetch(`${GITHUB_RAW_BASE}/filter-options.json`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      })
    ]);
    
    if (!catalogRes.ok || !filterRes.ok) {
      throw new Error(`Failed to fetch data: catalog=${catalogRes.status}, filter=${filterRes.status}`);
    }
    
    const catalogData = await catalogRes.json();
    // The catalog.json has a nested structure: { catalog: [...], stats: {...}, ... }
    catalogCache = catalogData.catalog || catalogData;
    filterOptionsCache = await filterRes.json();
    cacheTimestamp = now;
    
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  } catch (error) {
    console.error('Error fetching data from GitHub:', error);
    
    // Return cached data even if expired, if available
    if (catalogCache && filterOptionsCache) {
      return { catalog: catalogCache, filterOptions: filterOptionsCache };
    }
    
    throw error;
  }
}

// ===== HELPER FUNCTIONS =====

function parseGenreFilter(genre) {
  if (!genre) return null;
  return genre.replace(/\s*\(\d+\)$/, '').trim();
}

function parseWeekdayFilter(weekday) {
  if (!weekday) return null;
  return weekday.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
}

function parseSeasonFilter(seasonValue) {
  if (!seasonValue) return null;
  const cleanValue = seasonValue.replace(/\s*\(\d+\)$/, '').trim();
  const match = cleanValue.match(/^(\d{4})\s*-\s*(\w+)$/);
  if (match) {
    return { year: parseInt(match[1]), season: match[2].toLowerCase() };
  }
  return null;
}

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

// Filter out entries that are separate seasons of shows already covered by a main entry
// These have IMDB IDs that cover all seasons, so we don't need separate catalog entries
const HIDDEN_DUPLICATE_ENTRIES = new Set([
  'mal-57658',    // JJK: The Culling Game Part 1 (covered by tt12343534 S3)
  'tt36956670',   // JJK: Hidden Inventory/Premature Death (covered by tt12343534 S2)
  'tt14331144',   // JJK 0 movie (keep as separate - this is a movie)
  // Add more as needed
]);

// Manual poster overrides for anime with broken/missing metahub posters
const POSTER_OVERRIDES = {
  'tt38691315': 'https://media.kitsu.app/anime/50202/poster_image/large-b0a51e52146b1d81d8d0924b5a8bbe82.jpeg', // Style of Hiroshi Nohara Lunch
  'tt35348212': 'https://media.kitsu.app/anime/49843/poster_image/large-805a2f6fe1d62a8f6221dd07c7bce005.jpeg', // Kaijuu Sekai Seifuku (TV)
  // Add more overrides as needed
};

function isHiddenDuplicate(anime) {
  return HIDDEN_DUPLICATE_ENTRIES.has(anime.id);
}

function isMovieType(anime) {
  if (anime.subtype === 'movie') return true;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return true;
  return false;
}

// ===== FORMAT FUNCTIONS =====

function formatAnimeMeta(anime) {
  const formatted = { ...anime };
  formatted.type = anime.subtype === 'movie' ? 'movie' : 'series';
  
  if (anime.rating !== null && anime.rating !== undefined && !isNaN(anime.rating)) {
    formatted.imdbRating = anime.rating.toFixed(1);
  }
  
  if (anime.year) {
    formatted.releaseInfo = anime.year.toString();
  }
  
  if (anime.description && anime.description.length > 200) {
    formatted.description = anime.description.substring(0, 200) + '...';
  }
  
  // Poster priority: 1) Manual override, 2) Metahub (Cinemeta), 3) Catalog (Kitsu)
  if (POSTER_OVERRIDES[anime.id]) {
    formatted.poster = POSTER_OVERRIDES[anime.id];
  } else if (anime.id && anime.id.startsWith('tt')) {
    formatted.poster = `https://images.metahub.space/poster/medium/${anime.id}/img`;
  }
  // If no IMDB ID, keep the catalog poster (Kitsu)
  
  return formatted;
}

// ===== SEARCH FUNCTION =====

function searchDatabase(catalogData, query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of catalogData) {
    if (isHiddenDuplicate(anime)) continue;
    if (targetType === 'series' && !isSeriesType(anime)) continue;
    if (targetType === 'movie' && !isMovieType(anime)) continue;
    
    const name = (anime.name || '').toLowerCase();
    const description = (anime.description || '').toLowerCase();
    const genres = (anime.genres || []).map(g => g.toLowerCase());
    const studios = (anime.studios || []).map(s => s.toLowerCase());
    
    let score = 0;
    
    if (name === normalizedQuery) {
      score += 1000;
    } else if (name.startsWith(normalizedQuery)) {
      score += 500;
    } else if (name.includes(normalizedQuery)) {
      score += 200;
    }
    
    for (const word of queryWords) {
      if (name.includes(word)) score += 50;
    }
    
    for (const word of queryWords) {
      if (genres.some(g => g.includes(word))) score += 30;
      if (studios.some(s => s.includes(word))) score += 30;
    }
    
    if (description.includes(normalizedQuery)) score += 20;
    
    if (score > 0) {
      score += (anime.rating || 0) / 10;
      scored.push({ anime, score });
    }
  }
  
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.anime.rating || 0) - (a.anime.rating || 0);
  });
  
  return scored.map(s => s.anime);
}

// ===== CATALOG HANDLERS =====

function handleTopRated(catalogData, genreFilter, config) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !isHiddenDuplicate(anime));
  
  if (genreFilter) {
    const genre = parseGenreFilter(genreFilter);
    filtered = filtered.filter(anime => 
      anime.genres && anime.genres.some(g => 
        g.toLowerCase() === genre.toLowerCase()
      )
    );
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleSeasonReleases(catalogData, seasonFilter) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !isHiddenDuplicate(anime));
  
  if (seasonFilter) {
    const parsed = parseSeasonFilter(seasonFilter);
    if (parsed) {
      filtered = filtered.filter(anime => {
        if (!anime.year) return false;
        if (anime.year !== parsed.year) return false;
        return true;
      });
    }
  }
  
  filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
  return filtered;
}

function handleAiring(catalogData, genreFilter, config) {
  let filtered = catalogData.filter(anime => 
    anime.status === 'ONGOING' && isSeriesType(anime) && !isHiddenDuplicate(anime)
  );
  
  // Apply exclude long-running filter
  // This hides shows like One Piece, Naruto, Doraemon that have 100s of episodes
  // Shows with < 100 episodes are never considered "long-running"
  if (config.excludeLongRunning) {
    const currentYear = new Date().getFullYear();
    filtered = filtered.filter(anime => {
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || 0;
      // Allow if: started in last 10 years AND has < 200 episodes
      // OR if it has < 100 episodes (definitely not long-running)
      return (year >= currentYear - 10 && episodeCount < 200) || episodeCount < 100;
    });
  }
  
  // Filter by weekday if specified
  if (genreFilter) {
    const weekday = parseWeekdayFilter(genreFilter);
    if (weekday) {
      filtered = filtered.filter(anime => 
        anime.broadcastDay && anime.broadcastDay.toLowerCase() === weekday
      );
    }
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleMovies(catalogData, genreFilter) {
  let filtered = catalogData.filter(anime => isMovieType(anime) && !isHiddenDuplicate(anime));
  
  if (genreFilter) {
    const cleanFilter = parseGenreFilter(genreFilter);
    
    if (cleanFilter === 'Upcoming') {
      filtered = filtered.filter(anime => anime.status !== 'FINISHED');
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (cleanFilter === 'New Releases') {
      const currentYear = new Date().getFullYear();
      filtered = filtered.filter(anime => 
        anime.year >= currentYear - 1 && anime.status === 'FINISHED'
      );
      filtered.sort((a, b) => {
        if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
        return (b.rating || 0) - (a.rating || 0);
      });
    } else {
      filtered = filtered.filter(anime => 
        anime.genres && anime.genres.some(g => 
          g.toLowerCase() === cleanFilter.toLowerCase()
        )
      );
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
  } else {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }
  
  return filtered;
}

// ===== MANIFEST =====

function getManifest(filterOptions, showCounts = true) {
  const genreOptions = showCounts && filterOptions.genres?.withCounts 
    ? filterOptions.genres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))
    : (filterOptions.genres?.list || []).filter(g => g.toLowerCase() !== 'animation');
  
  const seasonOptions = showCounts && filterOptions.seasons?.withCounts 
    ? filterOptions.seasons.withCounts 
    : (filterOptions.seasons?.list || []);
  
  const weekdayOptions = showCounts && filterOptions.weekdays?.withCounts 
    ? filterOptions.weekdays.withCounts 
    : (filterOptions.weekdays?.list || []);
  
  const movieOptions = showCounts && filterOptions.movieGenres?.withCounts 
    ? ['Upcoming', 'New Releases', ...filterOptions.movieGenres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))]
    : ['Upcoming', 'New Releases', ...(filterOptions.movieGenres?.list || []).filter(g => g.toLowerCase() !== 'animation')];

  return {
    id: 'community.animestream',
    version: '1.4.0',
    name: 'AnimeStream',
    description: 'Comprehensive anime catalog with 7,000+ titles. Streaming powered by AllAnime.',
    // CRITICAL: Use explicit resource objects with types and idPrefixes
    // for Stremio to properly route stream requests
    resources: [
      'catalog',
      {
        name: 'meta',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      },
      {
        name: 'stream',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      }
    ],
    types: ['anime', 'series', 'movie'],
    idPrefixes: ['tt', 'kitsu', 'mal'],
    catalogs: [
      {
        id: 'anime-top-rated',
        type: 'anime',
        name: 'Top Rated',
        extra: [
          { name: 'genre', options: genreOptions, isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        id: 'anime-season-releases',
        type: 'anime',
        name: 'Season Releases',
        extra: [
          { name: 'genre', options: seasonOptions, isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        id: 'anime-airing',
        type: 'anime',
        name: 'Currently Airing',
        extra: [
          { name: 'genre', options: weekdayOptions, isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        id: 'anime-movies',
        type: 'anime',
        name: 'Movies',
        extra: [
          { name: 'genre', options: movieOptions, isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        id: 'anime-series-search',
        type: 'series',
        name: 'Anime Series',
        extra: [
          { name: 'search', isRequired: true },
          { name: 'skip' }
        ]
      },
      {
        id: 'anime-movies-search',
        type: 'movie',
        name: 'Anime Movies',
        extra: [
          { name: 'search', isRequired: true },
          { name: 'skip' }
        ]
      }
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    logo: 'https://i.imgur.com/t8iqMpT.png',
    background: 'https://i.imgur.com/Y8hMtVt.jpg'
  };
}

// ===== CONFIG PARSING =====

function parseConfig(configStr) {
  const config = { excludeLongRunning: true, showCounts: true };
  
  if (!configStr) return config;
  
  const params = configStr.split('&');
  for (const param of params) {
    const [key, value] = param.split('=');
    if (key === 'excludeLongRunning') {
      config.excludeLongRunning = value !== '0' && value !== 'false';
    }
    if (key === 'showCounts') {
      config.showCounts = value !== '0' && value !== 'false';
    }
  }
  
  return config;
}

// ===== STREAM HANDLING =====

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  if (m === 0) return n;
  if (n === 0) return m;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  
  return dp[m][n];
}

function stringSimilarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(str1, str2);
  return ((maxLen - distance) / maxLen) * 100;
}

// Find anime by any ID in catalog (supports IMDB tt*, MAL mal-*, Kitsu kitsu:*)
function findAnimeById(catalog, id) {
  // Try exact match on id field first
  let anime = catalog.find(a => a.id === id);
  if (anime) return anime;
  
  // For IMDB IDs, also check imdb_id field
  if (id.startsWith('tt')) {
    anime = catalog.find(a => a.imdb_id === id);
    if (anime) return anime;
  }
  
  // For MAL IDs (mal-12345), check mal_id field
  if (id.startsWith('mal-')) {
    const malId = id.replace('mal-', '');
    anime = catalog.find(a => a.mal_id === malId || a.id === id);
    if (anime) return anime;
  }
  
  // For Kitsu IDs (kitsu:12345), check kitsu_id field  
  if (id.startsWith('kitsu:')) {
    const kitsuId = id.replace('kitsu:', '');
    anime = catalog.find(a => a.kitsu_id === kitsuId || a.id === id);
    if (anime) return anime;
  }
  
  return null;
}

// Legacy function for backwards compatibility
function findAnimeByImdbId(catalog, imdbId) {
  return findAnimeById(catalog, imdbId);
}

// Search AllAnime for matching show (using direct API)
async function findAllAnimeShow(title) {
  if (!title) return null;
  
  try {
    const results = await searchAllAnime(title, 10);
    
    if (!results || results.length === 0) return null;
    
    // Normalize titles for matching
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Find best match using Levenshtein distance
    let bestMatch = null;
    let bestScore = 0;
    
    for (const show of results) {
      let score = 0;
      const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const nativeTitle = (show.nativeTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Exact match
      if (showName === normalizedTitle) {
        score = 100;
      } else if (showName.includes(normalizedTitle) || normalizedTitle.includes(showName)) {
        score = 80;
      } else {
        // Fuzzy match
        const similarity = Math.max(
          stringSimilarity(normalizedTitle, showName),
          stringSimilarity(normalizedTitle, nativeTitle)
        );
        score = similarity * 0.9;
      }
      
      if (show.type === 'TV') score += 3;
      if (show.type === 'Movie') score += 2;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = show;
      }
    }
    
    if (bestMatch && bestScore >= 60) {
      return bestMatch.id;
    }
    
    return null;
  } catch (e) {
    console.error('Search error:', e);
    return null;
  }
}

// Season-aware search for AllAnime shows
// Many anime have separate AllAnime entries per season (e.g., "Jujutsu Kaisen Season 2")
async function findAllAnimeShowForSeason(title, season) {
  if (!title) return null;
  
  // Known season name mappings for popular shows
  // Maps: "base title" + season number -> AllAnime search terms
  const seasonMappings = {
    'jujutsu kaisen': {
      1: ['Jujutsu Kaisen'],
      2: ['Jujutsu Kaisen Season 2', 'Jujutsu Kaisen 2nd Season'],
      3: ['Jujutsu Kaisen: The Culling Game', 'Jujutsu Kaisen Season 3', 'Jujutsu Kaisen Culling Game']
    },
    'attack on titan': {
      1: ['Attack on Titan'],
      2: ['Attack on Titan Season 2'],
      3: ['Attack on Titan Season 3'],
      4: ['Attack on Titan: The Final Season', 'Attack on Titan Final Season']
    },
    'my hero academia': {
      1: ['My Hero Academia'],
      2: ['My Hero Academia Season 2', 'My Hero Academia 2nd Season'],
      3: ['My Hero Academia Season 3', 'My Hero Academia 3rd Season'],
      4: ['My Hero Academia Season 4', 'My Hero Academia 4th Season'],
      5: ['My Hero Academia Season 5', 'My Hero Academia 5th Season'],
      6: ['My Hero Academia Season 6', 'My Hero Academia 6th Season'],
      7: ['My Hero Academia Season 7', 'My Hero Academia 7th Season']
    },
    'demon slayer': {
      1: ['Demon Slayer', 'Kimetsu no Yaiba'],
      2: ['Demon Slayer: Entertainment District Arc', 'Demon Slayer Season 2'],
      3: ['Demon Slayer: Swordsmith Village Arc', 'Demon Slayer Season 3'],
      4: ['Demon Slayer: Hashira Training Arc', 'Demon Slayer Season 4']
    }
  };
  
  const normalizedBaseTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  
  // Check if we have a known mapping
  for (const [baseName, seasons] of Object.entries(seasonMappings)) {
    if (normalizedBaseTitle.includes(baseName) || baseName.includes(normalizedBaseTitle)) {
      if (seasons[season]) {
        // Try each search term for this season
        for (const searchTerm of seasons[season]) {
          console.log(`Trying season mapping: "${searchTerm}" for ${title} S${season}`);
          const showId = await findAllAnimeShow(searchTerm);
          if (showId) {
            console.log(`Found show via season mapping: ${showId}`);
            return showId;
          }
        }
      }
    }
  }
  
  // Generic season search strategies
  const searchStrategies = [];
  
  if (season === 1) {
    // For season 1, just search the base title
    searchStrategies.push(title);
  } else {
    // For other seasons, try various naming conventions
    searchStrategies.push(`${title} Season ${season}`);
    searchStrategies.push(`${title} ${season}${getOrdinalSuffix(season)} Season`);
    searchStrategies.push(`${title} Part ${season}`);
    searchStrategies.push(title); // Fallback to base title
  }
  
  for (const searchTerm of searchStrategies) {
    console.log(`Searching AllAnime with: "${searchTerm}"`);
    const showId = await findAllAnimeShow(searchTerm);
    if (showId) {
      return showId;
    }
  }
  
  return null;
}

// Helper for ordinal suffixes (1st, 2nd, 3rd, etc.)
function getOrdinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}

// Handle meta requests - provide episode data from AllAnime
// Also enriches metadata from AllAnime when Cinemeta data is poor
async function handleMeta(catalog, type, id) {
  // Decode URL-encoded ID
  const decodedId = decodeURIComponent(id);
  const baseId = decodedId.split(':')[0];
  
  console.log(`Meta request for ${baseId}`);
  
  // First check our catalog (supports tt*, mal-*, kitsu:*)
  let anime = findAnimeById(catalog, baseId);
  let cinemeta = null;
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    cinemeta = await fetchCinemetaMeta(baseId, type);
    anime = cinemeta;
  }
  
  if (!anime) {
    console.log(`No anime found for meta: ${baseId}`);
    return { meta: null };
  }
  
  // Check if we need to enrich metadata from AllAnime/Cinemeta
  const needsEnrichment = isMetadataIncomplete(anime);
  
  // Search AllAnime for this show
  const showId = await findAllAnimeShow(anime.name);
  let showDetails = null;
  
  if (showId) {
    // Get full show details from AllAnime
    showDetails = await getAllAnimeShowDetails(showId);
    if (showDetails && needsEnrichment) {
      console.log(`Enriching metadata from AllAnime for: ${anime.name}`);
    }
  } else {
    console.log(`No AllAnime match for: ${anime.name}`);
  }
  
  // If we still need enrichment and AllAnime failed, try Cinemeta as fallback
  // (Only for IMDB IDs, and only if we don't already have Cinemeta data)
  if (needsEnrichment && !showDetails && !cinemeta && baseId.startsWith('tt')) {
    console.log(`Trying Cinemeta fallback for: ${anime.name}`);
    cinemeta = await fetchCinemetaMeta(baseId, type);
  }
  
  // Build episodes from AllAnime data (if available) or catalog data
  const episodes = [];
  
  if (showDetails) {
    const availableEps = showDetails.availableEpisodesDetail || {};
    const subEpisodes = availableEps.sub || [];
    const dubEpisodes = availableEps.dub || [];
    
    // Use sub episodes as the primary list (usually more complete)
    const allEpisodes = [...new Set([...subEpisodes, ...dubEpisodes])].sort((a, b) => parseFloat(a) - parseFloat(b));
    
    for (const epNum of allEpisodes) {
      const epNumber = parseFloat(epNum);
      // Assume season 1 for now (most anime)
      const season = 1;
      
      episodes.push({
        id: `${baseId}:${season}:${Math.floor(epNumber)}`,
        title: `Episode ${epNumber}`,
        season: season,
        episode: Math.floor(epNumber),
        thumbnail: showDetails.thumbnail || anime.poster, // Use show poster as fallback thumbnail
        released: new Date().toISOString() // AllAnime doesn't provide release dates easily
      });
    }
  } else if (cinemeta && cinemeta.videos && cinemeta.videos.length > 0) {
    // Use Cinemeta videos as second fallback
    episodes.push(...cinemeta.videos);
  } else if (anime.videos && anime.videos.length > 0) {
    // Use catalog videos as last resort
    episodes.push(...anime.videos);
  }
  
  // Build meta object with enrichment from best available source
  // Priority: AllAnime > Cinemeta > Catalog
  const hasAllAnime = showDetails !== null;
  const hasCinemeta = cinemeta !== null;
  
  // Determine best source for each field
  const bestPoster = hasAllAnime && showDetails.thumbnail ? showDetails.thumbnail :
                     hasCinemeta && cinemeta.poster ? cinemeta.poster : 
                     anime.poster;
  
  const bestDescription = hasAllAnime && showDetails.description ? showDetails.description :
                          hasCinemeta && cinemeta.description ? cinemeta.description :
                          anime.description || '';
  
  const bestBackground = hasAllAnime && showDetails.banner ? showDetails.banner :
                         hasCinemeta && cinemeta.background ? cinemeta.background :
                         anime.background;
  
  const bestGenres = hasAllAnime && showDetails.genres ? showDetails.genres :
                     hasCinemeta && cinemeta.genres ? cinemeta.genres :
                     anime.genres || [];
  
  const meta = {
    id: baseId,
    type: 'series',
    name: anime.name, // Keep original name for consistency
    poster: bestPoster,
    background: bestBackground,
    description: stripHtml(bestDescription),
    genres: bestGenres,
    runtime: anime.runtime,
    videos: episodes,
    releaseInfo: anime.releaseInfo || 
                 (hasAllAnime && showDetails.status === 'Releasing' ? 'Ongoing' : 
                  hasAllAnime ? showDetails.status : undefined)
  };
  
  const source = hasAllAnime ? (needsEnrichment ? 'AllAnime-enriched' : 'AllAnime+catalog') : 
                 hasCinemeta ? 'Cinemeta-enriched' : 'catalog-only';
  console.log(`Returning meta with ${episodes.length} episodes for ${meta.name} (${source})`);
  return { meta };
}

// Handle stream requests (using direct API)
async function handleStream(catalog, type, id) {
  // Decode URL-encoded ID first (Stremio sometimes sends %3A instead of :)
  const decodedId = decodeURIComponent(id);
  
  // Parse ID: tt1234567 or tt1234567:1:5 or mal-12345:1:5
  const parts = decodedId.split(':');
  const baseId = parts[0];
  const season = parts[1] ? parseInt(parts[1]) : 1;
  const episode = parts[2] ? parseInt(parts[2]) : 1;
  
  console.log(`Stream request: baseId=${baseId}, season=${season}, episode=${episode}`);
  
  // Find anime in catalog (supports tt*, mal-*, kitsu:* IDs)
  let anime = findAnimeById(catalog, baseId);
  let showId = null;
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    console.log(`Anime not in catalog, trying Cinemeta for ${baseId}`);
    anime = await fetchCinemetaMeta(baseId, type);
  }
  
  // If still not found and it's a MAL ID, search AllAnime directly
  if (!anime && baseId.startsWith('mal-')) {
    console.log(`MAL ID detected, searching AllAnime directly for ${baseId}`);
    const malId = baseId.replace('mal-', '');
    
    // Search AllAnime by MAL ID - try to get show details directly
    try {
      const showDetails = await getAllAnimeShowDetails(malId);
      if (showDetails) {
        showId = malId; // We have the MAL ID which AllAnime uses
        anime = { name: showDetails.name || showDetails.englishName || 'Unknown' };
        console.log(`Found AllAnime show via MAL ID: ${anime.name}`);
      }
    } catch (err) {
      console.log(`AllAnime lookup by MAL ID failed: ${err.message}`);
    }
  }
  
  if (!anime) {
    console.log(`No anime found for ${baseId}`);
    return { streams: [] };
  }
  
  // Search AllAnime for matching show (if we don't already have showId)
  // For multi-season shows, we need to find the correct season entry
  if (!showId) {
    showId = await findAllAnimeShowForSeason(anime.name, season);
  }
  if (!showId) {
    return { streams: [] };
  }
  
  // Fetch streams directly from AllAnime API
  try {
    const streams = await getEpisodeSources(showId, episode);
    
    if (!streams || streams.length === 0) {
      return { streams: [] };
    }
    
    // Format streams for Stremio - use proxy for URLs requiring Referer header
    const workerBaseUrl = 'https://animestream-addon.keypop3750.workers.dev';
    
    const formattedStreams = streams.map(stream => {
      // Proxy URLs that require Referer header (fast4speed)
      let streamUrl = stream.url;
      if (stream.url.includes('fast4speed')) {
        streamUrl = `${workerBaseUrl}/proxy/${encodeURIComponent(stream.url)}`;
      }
      
      return {
        name: `AnimeStream`,
        title: `${stream.type || 'SUB'} - ${stream.quality || 'HD'}`,
        url: streamUrl
      };
    });
    
    return { streams: formattedStreams };
  } catch (e) {
    console.error('Stream fetch error:', e);
    return { streams: [] };
  }
}

// ===== MAIN HANDLER =====

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // ===== VIDEO PROXY =====
    // Proxy video streams to add required Referer header
    if (path.startsWith('/proxy/')) {
      const videoUrl = decodeURIComponent(path.replace('/proxy/', ''));
      
      try {
        // Handle range requests for video seeking
        const rangeHeader = request.headers.get('Range');
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://allanime.to/',
          'Origin': 'https://allanime.to'
        };
        
        if (rangeHeader) {
          headers['Range'] = rangeHeader;
        }
        
        const response = await fetch(videoUrl, { headers });
        
        // Return proxied video with CORS headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', 'Range');
        newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: error.message }), {
          status: 502,
          headers: JSON_HEADERS
        });
      }
    }
    
    // Health check (doesn't need data)
    if (path === '/health' || path === '/') {
      try {
        const { catalog } = await fetchCatalogData();
        return new Response(JSON.stringify({
          status: 'healthy',
          database: 'loaded',
          source: 'github',
          totalAnime: catalog.length,
          cacheAge: Math.floor((Date.now() - cacheTimestamp) / 1000) + 's'
        }), { headers: JSON_HEADERS });
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'error',
          message: error.message
        }), { status: 500, headers: JSON_HEADERS });
      }
    }
    
    // Fetch data for all other routes
    let catalog, filterOptions;
    try {
      const data = await fetchCatalogData();
      catalog = data.catalog;
      filterOptions = data.filterOptions;
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Failed to load catalog data',
        message: error.message 
      }), { status: 503, headers: JSON_HEADERS });
    }
    
    // Parse routes
    const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
    if (manifestMatch) {
      const config = parseConfig(manifestMatch[1]);
      return new Response(JSON.stringify(getManifest(filterOptions, config.showCounts)), { headers: JSON_HEADERS });
    }
    
    const catalogMatch = path.match(/^(?:\/([^\/]+))?\/catalog\/([^\/]+)\/([^\/]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, configStr, type, id, extraStr] = catalogMatch;
      const config = parseConfig(configStr);
      
      // Parse extra parameters
      const extra = {};
      if (extraStr) {
        const parts = extraStr.split('&');
        for (const part of parts) {
          const [key, value] = part.split('=');
          if (key && value) {
            extra[key] = decodeURIComponent(value);
          }
        }
      }
      
      // Handle search catalogs
      if (id === 'anime-search' || id === 'anime-series-search' || id === 'anime-movies-search') {
        if (!extra.search) {
          return new Response(JSON.stringify({ metas: [] }), { headers: JSON_HEADERS });
        }
        
        // Determine target type based on catalog id
        let targetType = null;
        if (id === 'anime-movies-search') targetType = 'movie';
        else if (id === 'anime-series-search') targetType = 'series';
        // anime-search searches all types
        
        const results = searchDatabase(catalog, extra.search, targetType);
        
        const skip = parseInt(extra.skip) || 0;
        const paginated = results.slice(skip, skip + PAGE_SIZE);
        const metas = paginated.map(formatAnimeMeta);
        
        return new Response(JSON.stringify({ metas }), { headers: JSON_HEADERS });
      }
      
      // Handle regular catalogs
      if (type !== 'anime') {
        return new Response(JSON.stringify({ metas: [] }), { headers: JSON_HEADERS });
      }
      
      let catalogResult;
      switch (id) {
        case 'anime-top-rated':
          catalogResult = handleTopRated(catalog, extra.genre, config);
          break;
        case 'anime-season-releases':
          catalogResult = handleSeasonReleases(catalog, extra.genre);
          break;
        case 'anime-airing':
          catalogResult = handleAiring(catalog, extra.genre, config);
          break;
        case 'anime-movies':
          catalogResult = handleMovies(catalog, extra.genre);
          break;
        default:
          return new Response(JSON.stringify({ metas: [] }), { headers: JSON_HEADERS });
      }
      
      const skip = parseInt(extra.skip) || 0;
      const paginated = catalogResult.slice(skip, skip + PAGE_SIZE);
      const metas = paginated.map(formatAnimeMeta);
      
      return new Response(JSON.stringify({ metas }), { headers: JSON_HEADERS });
    }
    
    // Debug route for stream tracing
    const debugMatch = path.match(/^\/debug\/stream\/(.+)$/);
    if (debugMatch) {
      const id = debugMatch[1];
      const parts = id.split(':');
      const imdbId = parts[0];
      const type = parts.length === 3 ? 'series' : 'movie';
      const episode = parts[2] ? parseInt(parts[2]) : 1;
      
      const debugInfo = {
        id,
        imdbId,
        episode,
        catalogLoaded: !!catalog,
        catalogSize: catalog ? catalog.length : 0
      };
      
      // Find anime in catalog
      let anime = findAnimeByImdbId(catalog, imdbId);
      debugInfo.animeFound = !!anime;
      debugInfo.source = anime ? 'catalog' : null;
      
      // If not in catalog, try Cinemeta
      if (!anime) {
        debugInfo.tryingCinemeta = true;
        anime = await fetchCinemetaMeta(imdbId, type);
        if (anime) {
          debugInfo.animeFound = true;
          debugInfo.source = 'cinemeta';
        }
      }
      
      if (anime) {
        debugInfo.animeName = anime.name;
        debugInfo.animeId = anime.id;
      }
      
      if (anime) {
        // Search AllAnime directly
        try {
          const results = await searchAllAnime(anime.name, 10);
          debugInfo.searchResultCount = results.length;
          
          if (results.length > 0) {
            debugInfo.firstResult = {
              id: results[0].id,
              title: results[0].title,
              type: results[0].type
            };
            
            // Run matching algorithm
            const normalizedTitle = anime.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            debugInfo.normalizedTitle = normalizedTitle;
            
            const matchResults = results.map(show => {
              const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const similarity = stringSimilarity(normalizedTitle, showName);
              let score = 0;
              if (showName === normalizedTitle) score = 100;
              else if (showName.includes(normalizedTitle) || normalizedTitle.includes(showName)) score = 80;
              else score = similarity * 0.9;
              if (show.type === 'TV') score += 3;
              
              return {
                id: show.id,
                title: show.title,
                normalizedTitle: showName,
                similarity,
                score,
                isExactMatch: showName === normalizedTitle
              };
            });
            
            debugInfo.matchResults = matchResults;
            debugInfo.bestMatch = matchResults.reduce((best, curr) => curr.score > best.score ? curr : best, matchResults[0]);
            
            // Also test stream fetching
            if (debugInfo.bestMatch && debugInfo.bestMatch.score >= 60) {
              const streams = await getEpisodeSources(debugInfo.bestMatch.id, episode);
              debugInfo.streamsFound = streams.length;
              if (streams.length > 0) {
                debugInfo.firstStream = {
                  url: streams[0].url.substring(0, 100) + '...',
                  quality: streams[0].quality,
                  type: streams[0].type
                };
              }
            }
          }
        } catch (e) {
          debugInfo.searchError = e.message;
        }
      }
      
      return new Response(JSON.stringify(debugInfo, null, 2), { headers: JSON_HEADERS });
    }
    
    // Meta route: /meta/:type/:id.json or /{config}/meta/:type/:id.json
    const metaMatch = path.match(/^(?:\/([^\/]+))?\/meta\/([^\/]+)\/(.+)\.json$/);
    if (metaMatch) {
      const [, configStr, type, id] = metaMatch;
      const result = await handleMeta(catalog, type, id);
      return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
    }
    
    // Stream route: /stream/:type/:id.json or /{config}/stream/:type/:id.json
    const streamMatch = path.match(/^(?:\/([^\/]+))?\/stream\/([^\/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const [, configStr, type, id] = streamMatch;
      const result = await handleStream(catalog, type, id);
      return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
    }
    
    // 404 for unknown routes
    return new Response(JSON.stringify({ error: 'Not found' }), { 
      status: 404, 
      headers: JSON_HEADERS 
    });
  }
};
