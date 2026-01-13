/**
 * AnimeStream Stremio Addon - Cloudflare Worker
 * 
 * A serverless Stremio addon that serves anime catalogs.
 * Catalog data is embedded at build time for instant loading.
 */

// ===== EMBEDDED DATA (will be replaced at build time) =====
// This gets replaced by the build script with actual data
const CATALOG_DATA = __CATALOG_DATA__;
const FILTER_OPTIONS = __FILTER_OPTIONS__;

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
  
  // Handle Kitsu poster URLs
  if (anime.poster) {
    if (anime.poster.includes('/poster_images/')) {
      formatted.poster = anime.poster.replace(/\/large\./, '/medium.');
    }
  }
  
  return formatted;
}

// ===== SEARCH FUNCTION =====

function searchDatabase(query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of CATALOG_DATA) {
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

function handleTopRated(genreFilter, config) {
  let filtered = CATALOG_DATA.filter(isSeriesType);
  
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

function handleSeasonReleases(seasonFilter) {
  let filtered = CATALOG_DATA.filter(isSeriesType);
  
  if (seasonFilter) {
    const parsed = parseSeasonFilter(seasonFilter);
    if (parsed) {
      filtered = filtered.filter(anime => {
        if (!anime.year) return false;
        if (anime.year !== parsed.year) return false;
        
        const seasonMap = {
          'winter': [1, 2, 3],
          'spring': [4, 5, 6],
          'summer': [7, 8, 9],
          'fall': [10, 11, 12]
        };
        
        return true; // Simplified - just filter by year
      });
    }
  }
  
  filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
  return filtered;
}

function handleAiring(genreFilter, config) {
  let filtered = CATALOG_DATA.filter(anime => 
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

function handleMovies(genreFilter) {
  let filtered = CATALOG_DATA.filter(isMovieType);
  
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

function getManifest(showCounts = true) {
  const genreOptions = showCounts && FILTER_OPTIONS.genres?.withCounts 
    ? FILTER_OPTIONS.genres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))
    : (FILTER_OPTIONS.genres?.list || []).filter(g => g.toLowerCase() !== 'animation');
  
  const seasonOptions = showCounts && FILTER_OPTIONS.seasons?.withCounts 
    ? FILTER_OPTIONS.seasons.withCounts 
    : (FILTER_OPTIONS.seasons?.list || []);
  
  const weekdayOptions = showCounts && FILTER_OPTIONS.weekdays?.withCounts 
    ? FILTER_OPTIONS.weekdays.withCounts 
    : (FILTER_OPTIONS.weekdays?.list || []);
  
  const movieOptions = showCounts && FILTER_OPTIONS.movieGenres?.withCounts 
    ? ['Upcoming', 'New Releases', ...FILTER_OPTIONS.movieGenres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))]
    : ['Upcoming', 'New Releases', ...(FILTER_OPTIONS.movieGenres?.list || []).filter(g => g.toLowerCase() !== 'animation')];

  return {
    id: 'community.animestream',
    version: '1.1.0',
    name: 'AnimeStream',
    description: 'Comprehensive anime catalog with 7,000+ titles.',
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
    
    // Health check
    if (path === '/health' || path === '/') {
      return new Response(JSON.stringify({
        status: 'healthy',
        database: 'loaded',
        totalAnime: CATALOG_DATA.length
      }), { headers: JSON_HEADERS });
    }
    
    // Parse route
    // Routes: /manifest.json, /{config}/manifest.json
    //         /catalog/{type}/{id}/{extra}.json
    //         /{config}/catalog/{type}/{id}/{extra}.json
    
    const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
    if (manifestMatch) {
      const config = parseConfig(manifestMatch[1]);
      return new Response(JSON.stringify(getManifest(config.showCounts)), { headers: JSON_HEADERS });
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
        const results = searchDatabase(extra.search, targetType);
        
        const skip = parseInt(extra.skip) || 0;
        const paginated = results.slice(skip, skip + PAGE_SIZE);
        const metas = paginated.map(formatAnimeMeta);
        
        return new Response(JSON.stringify({ metas }), { headers: JSON_HEADERS });
      }
      
      // Handle regular catalogs
      if (type !== 'anime') {
        return new Response(JSON.stringify({ metas: [] }), { headers: JSON_HEADERS });
      }
      
      let catalog;
      switch (id) {
        case 'anime-top-rated':
          catalog = handleTopRated(extra.genre, config);
          break;
        case 'anime-season-releases':
          catalog = handleSeasonReleases(extra.genre);
          break;
        case 'anime-airing':
          catalog = handleAiring(extra.genre, config);
          break;
        case 'anime-movies':
          catalog = handleMovies(extra.genre);
          break;
        default:
          return new Response(JSON.stringify({ metas: [] }), { headers: JSON_HEADERS });
      }
      
      const skip = parseInt(extra.skip) || 0;
      const paginated = catalog.slice(skip, skip + PAGE_SIZE);
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
