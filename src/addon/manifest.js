/**
 * AnimeStream Manifest
 * 
 * Defines the addon structure with custom 'anime' type catalogs:
 * - Top Rated: Sorted by rating with genre filters (series only)
 * - Season Releases: Filtered by anime season (series only)
 * - Currently Airing: Currently airing anime with weekday filters
 * - Movies: Anime movies with genre filters + Upcoming/New Releases
 */

const fs = require('fs');
const path = require('path');
const config = require('../config/env');

/**
 * Load dynamic filter options from database analysis
 */
function loadFilterOptions() {
  const optionsPath = path.join(__dirname, '..', '..', 'data', 'filter-options.json');
  
  try {
    if (fs.existsSync(optionsPath)) {
      return JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    }
  } catch (err) {
    console.warn('[Manifest] Could not load filter-options.json:', err.message);
  }
  
  return null;
}

/**
 * Get genre options with counts for Top Rated catalog (series only)
 * Filters out "Animation" since all anime is animation
 */
function getGenreOptions(showCounts = true) {
  const options = loadFilterOptions();
  
  // Filter function to remove "Animation" genre (all anime is animation)
  const filterAnimation = (genre) => {
    const lower = genre.toLowerCase();
    return !lower.startsWith('animation');
  };
  
  if (showCounts && options?.genres?.withCounts) {
    return options.genres.withCounts.filter(filterAnimation);
  }
  
  if (!showCounts && options?.genres?.list) {
    return options.genres.list.filter(filterAnimation);
  }
  
  // Fallback static list
  return [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror',
    'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life',
    'Sports', 'Supernatural', 'Thriller', 'Mecha', 'School', 'Isekai'
  ];
}

/**
 * Get movie filter options - special filters first, then genres alphabetically
 * Special filters include counts calculated from database
 */
function getMovieFilterOptions(showCounts = true) {
  const options = loadFilterOptions();
  
  // Get special filter counts from filter-options if available
  let upcomingCount = options?.movieSpecialFilters?.upcoming || 0;
  let newReleasesCount = options?.movieSpecialFilters?.newReleases || 0;
  
  // Special filters at the top (with counts if showCounts is true)
  let specialFilters;
  if (showCounts && (upcomingCount > 0 || newReleasesCount > 0)) {
    specialFilters = [
      `Upcoming (${upcomingCount})`,
      `New Releases (${newReleasesCount})`
    ];
  } else {
    specialFilters = ['Upcoming', 'New Releases'];
  }
  
  // Get movie genres
  let movieGenres = [];
  if (showCounts && options?.movieGenres?.withCounts) {
    movieGenres = options.movieGenres.withCounts;
  } else if (!showCounts && options?.movieGenres?.list) {
    movieGenres = options.movieGenres.list;
  } else if (showCounts && options?.genres?.withCounts) {
    // Fallback to regular genres if movieGenres not available
    movieGenres = options.genres.withCounts;
  } else if (options?.genres?.list) {
    movieGenres = options.genres.list;
  } else {
    // Final fallback
    movieGenres = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'Sci-Fi'];
  }
  
  return [...specialFilters, ...movieGenres];
}

/**
 * Get weekday options with counts for Currently Airing catalog
 */
function getWeekdayOptions(showCounts = true) {
  const options = loadFilterOptions();
  
  if (showCounts && options?.weekdays?.withCounts && options.weekdays.withCounts.length > 0) {
    return options.weekdays.withCounts;
  }
  
  if (!showCounts && options?.weekdays?.list) {
    return options.weekdays.list;
  }
  
  // Fallback static list (without counts)
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
}

/**
 * Get current anime season based on current month
 * Winter: Jan-Mar, Spring: Apr-Jun, Summer: Jul-Sep, Fall: Oct-Dec
 */
function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();
  
  let season;
  if (month <= 2) season = 'Winter';
  else if (month <= 5) season = 'Spring';
  else if (month <= 8) season = 'Summer';
  else season = 'Fall';
  
  return { year, season };
}

/**
 * Check if a season is in the future (hasn't started yet)
 */
function isFutureSeason(seasonYear, seasonName) {
  const current = getCurrentSeason();
  const seasonOrder = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };
  
  // Future year
  if (seasonYear > current.year) return true;
  
  // Same year but future season
  if (seasonYear === current.year && seasonOrder[seasonName] > seasonOrder[current.season]) {
    return true;
  }
  
  return false;
}

/**
 * Get season options with counts for Season Releases catalog
 * Filters out future seasons (which haven't started yet)
 * Adds "Upcoming" option for future seasons if they exist
 */
function getSeasonOptions(showCounts = true) {
  const options = loadFilterOptions();
  
  let seasonsList = [];
  let upcomingCount = 0;
  
  if (showCounts && options?.seasons?.withCounts) {
    // Parse and filter seasons
    for (const seasonWithCount of options.seasons.withCounts) {
      // Parse "2026 - Winter (37)" format
      const match = seasonWithCount.match(/^(\d{4})\s*-\s*(\w+)\s*\((\d+)\)$/);
      if (match) {
        const year = parseInt(match[1]);
        const season = match[2];
        const count = parseInt(match[3]);
        
        if (isFutureSeason(year, season)) {
          upcomingCount += count;
        } else {
          seasonsList.push(seasonWithCount);
        }
      } else {
        // Fallback for non-matching format
        seasonsList.push(seasonWithCount);
      }
    }
    
    // Add "Upcoming" option at the top if there are future seasons
    if (upcomingCount > 0) {
      seasonsList.unshift(`Upcoming (${upcomingCount})`);
    }
    
    return seasonsList;
  }
  
  if (!showCounts && options?.seasons?.list) {
    // Filter future seasons from the list
    const filtered = options.seasons.list.filter(({ name }) => {
      const match = name.match(/^(\d{4})\s*-\s*(\w+)$/);
      if (match) {
        return !isFutureSeason(parseInt(match[1]), match[2]);
      }
      return true;
    });
    
    // Check if there are future seasons
    const hasFuture = options.seasons.list.some(({ name }) => {
      const match = name.match(/^(\d{4})\s*-\s*(\w+)$/);
      return match && isFutureSeason(parseInt(match[1]), match[2]);
    });
    
    if (hasFuture) {
      return ['Upcoming', ...filtered.map(s => s.name)];
    }
    return filtered.map(s => s.name);
  }
  
  // Fallback: generate recent seasons (current and past only)
  const seasons = [];
  const current = getCurrentSeason();
  const seasonNames = ['Winter', 'Spring', 'Summer', 'Fall'];
  
  for (let year = current.year; year >= current.year - 5; year--) {
    for (const season of seasonNames) {
      // Skip future seasons
      if (!isFutureSeason(year, season)) {
        seasons.push(`${year} - ${season}`);
      }
    }
  }
  
  return seasons;
}

/**
 * Generate manifest with dynamic filter options
 * @param {Object} config - User configuration options
 */
function getManifest(userConfig = {}) {
  const showCounts = userConfig.showCounts !== false; // Default true
  
  const genreOptions = getGenreOptions(showCounts);
  const seasonOptions = getSeasonOptions(showCounts);
  const weekdayOptions = getWeekdayOptions(showCounts);
  const movieFilterOptions = getMovieFilterOptions(showCounts);
  
  return {
    id: 'community.animestream',
    version: '1.0.0',  // Bumped version for streaming capability
    name: 'AnimeStream',
    description: 'Comprehensive anime catalog with 7,000+ titles and streaming from AllAnime. Features Top Rated, Season Releases, Currently Airing, and Movies catalogs with genre filtering.',
    
    // Resources we provide - catalog + stream from AllAnime
    resources: ['catalog', 'stream'],
    
    // Types we handle - anime (custom) + series + movie for proper Stremio display
    types: ['anime', 'series', 'movie'],
    
    // ID prefixes we respond to
    idPrefixes: ['tt'],
    
    // Catalogs with custom 'anime' type
    catalogs: [
      {
        id: 'anime-top-rated',
        type: 'anime',
        name: 'Top Rated',
        extra: [
          {
            name: 'genre',
            options: genreOptions,
            isRequired: false
          },
          {
            name: 'skip',
            isRequired: false
          }
        ]
      },
      {
        id: 'anime-season-releases',
        type: 'anime',
        name: 'Season Releases',
        extra: [
          {
            name: 'genre',
            options: seasonOptions,
            isRequired: false
          },
          {
            name: 'skip',
            isRequired: false
          }
        ]
      },
      {
        id: 'anime-airing',
        type: 'anime',
        name: 'Currently Airing',
        extra: [
          {
            name: 'genre',
            options: weekdayOptions,  // Weekday filter (Monday, Tuesday, etc.)
            isRequired: false
          },
          {
            name: 'skip',
            isRequired: false
          }
        ]
      },
      {
        id: 'anime-movies',
        type: 'anime',
        name: 'Movies',
        extra: [
          {
            name: 'genre',
            options: movieFilterOptions,
            isRequired: false
          },
          {
            name: 'skip',
            isRequired: false
          }
        ]
      },
      // Search-only catalogs (hidden from browse, used for search routing)
      // These ensure Stremio routes search queries to our addon
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
    
    // Behavior hints
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    
    // Contact info
    contactEmail: 'animestream@example.com',
    
    // Logo and background
    logo: 'https://i.imgur.com/t8iqMpT.png',
    background: 'https://i.imgur.com/Y8hMtVt.jpg'
  };
}

// Export genres for use in handlers
const GENRE_OPTIONS = getGenreOptions();
const SEASON_OPTIONS = getSeasonOptions();

module.exports = {
  getManifest,
  GENRE_OPTIONS,
  SEASON_OPTIONS
};
