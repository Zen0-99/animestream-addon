/**
 * AnimeStream Stremio Addon - Cloudflare Worker (GitHub-backed)
 * 
 * A lightweight serverless Stremio addon that fetches catalog data from GitHub.
 * No embedded data - stays under Cloudflare's 1MB limit easily.
 */

// ===== CONFIGURATION =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data';
const CACHE_TTL = 3600; // 1 hour cache for GitHub data

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

// ===== DATA CACHE (in-memory per worker instance) =====
let catalogCache = null;
let filterOptionsCache = null;
let cacheTimestamp = 0;

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
  
  // Remove poster so Stremio uses Cinemeta's higher quality posters
  // Cinemeta will fetch the poster based on the IMDB ID (tt...)
  delete formatted.poster;
  
  return formatted;
}

// ===== SEARCH FUNCTION =====

function searchDatabase(catalogData, query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of catalogData) {
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
  let filtered = catalogData.filter(isSeriesType);
  
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
  let filtered = catalogData.filter(isSeriesType);
  
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
    anime.status === 'ONGOING' && isSeriesType(anime)
  );
  
  // Apply exclude long-running filter
  if (config.excludeLongRunning) {
    const currentYear = new Date().getFullYear();
    filtered = filtered.filter(anime => {
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || 0;
      return year >= currentYear - 5 && episodeCount < 200;
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
  let filtered = catalogData.filter(isMovieType);
  
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
    version: '1.2.0',
    name: 'AnimeStream',
    description: 'Comprehensive anime catalog with 7,000+ titles. Powered by GitHub.',
    resources: ['catalog'],
    types: ['anime', 'series', 'movie'],
    idPrefixes: ['tt'],
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

// ===== MAIN HANDLER =====

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
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
      
      // Handle search
      if (id === 'anime-series-search' || id === 'anime-movies-search') {
        if (!extra.search) {
          return new Response(JSON.stringify({ metas: [] }), { headers: JSON_HEADERS });
        }
        
        const targetType = id === 'anime-movies-search' ? 'movie' : 'series';
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
    
    // 404 for unknown routes
    return new Response(JSON.stringify({ error: 'Not found' }), { 
      status: 404, 
      headers: JSON_HEADERS 
    });
  }
};
