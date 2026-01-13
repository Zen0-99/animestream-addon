/**
 * Update filter-options.json with movie genres
 * Regenerates the entire file from catalog data
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Load catalog from gzipped file
const catalogGz = fs.readFileSync(path.join(DATA_DIR, 'catalog.json.gz'));
const catalogData = JSON.parse(zlib.gunzipSync(catalogGz).toString('utf8'));
const catalog = catalogData.catalog;

console.log(`Loaded ${catalog.length} anime from catalog`);

// Start fresh filter options
const filterOptions = {};

// === Calculate Series Genres (excluding movies) ===
const series = catalog.filter(a => a.subtype !== 'movie');
const seriesGenreCounts = {};

for (const s of series) {
  if (s.genres && Array.isArray(s.genres)) {
    for (const g of s.genres) {
      seriesGenreCounts[g] = (seriesGenreCounts[g] || 0) + 1;
    }
  }
}

// Sort series genres by count
const sortedSeriesGenres = Object.entries(seriesGenreCounts)
  .sort((a, b) => b[1] - a[1]);

filterOptions.genres = {
  list: sortedSeriesGenres.map(([g]) => g),
  withCounts: sortedSeriesGenres.map(([g, c]) => `${g} (${c})`)
};

// === Calculate Movie Genres ===
const movies = catalog.filter(a => a.subtype === 'movie');
const movieGenreCounts = {};

for (const m of movies) {
  if (m.genres && Array.isArray(m.genres)) {
    for (const g of m.genres) {
      movieGenreCounts[g] = (movieGenreCounts[g] || 0) + 1;
    }
  }
}

// Sort movie genres by count
const sortedMovieGenres = Object.entries(movieGenreCounts)
  .sort((a, b) => b[1] - a[1]);

filterOptions.movieGenres = {
  list: sortedMovieGenres.map(([g]) => g),
  withCounts: sortedMovieGenres.map(([g, c]) => `${g} (${c})`)
};

// === Calculate Season Counts (series only) ===
const seasonCounts = {};
for (const s of series) {
  if (s.year && s.season) {
    const seasonName = s.season.charAt(0).toUpperCase() + s.season.slice(1).toLowerCase();
    const seasonKey = `${s.year} - ${seasonName}`;
    seasonCounts[seasonKey] = (seasonCounts[seasonKey] || 0) + 1;
  }
}

// Sort seasons by year (newest first), then season order
const sortedSeasons = Object.entries(seasonCounts)
  .sort((a, b) => {
    const [yearA, seasonA] = a[0].split(' - ');
    const [yearB, seasonB] = b[0].split(' - ');
    if (yearA !== yearB) return parseInt(yearB) - parseInt(yearA);
    const seasonOrder = { Winter: 4, Fall: 3, Summer: 2, Spring: 1 };
    return (seasonOrder[seasonB] || 0) - (seasonOrder[seasonA] || 0);
  });

filterOptions.seasons = {
  list: sortedSeasons.map(([s]) => s),
  withCounts: sortedSeasons.map(([s, c]) => `${s} (${c})`)
};

// === Calculate Weekday Counts (for Currently Airing) ===
const ongoing = series.filter(a => a.status === 'ONGOING' && a.broadcastDay);
const weekdayCounts = {};

for (const a of ongoing) {
  if (a.broadcastDay) {
    const day = a.broadcastDay.charAt(0).toUpperCase() + a.broadcastDay.slice(1).toLowerCase();
    weekdayCounts[day] = (weekdayCounts[day] || 0) + 1;
  }
}

// Sort weekdays in proper order
const weekdayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const sortedWeekdays = weekdayOrder
  .filter(day => weekdayCounts[day])
  .map(day => [day, weekdayCounts[day]]);

filterOptions.weekdays = {
  list: sortedWeekdays.map(([d]) => d),
  withCounts: sortedWeekdays.map(([d, c]) => `${d} (${c})`)
};

// === Stats ===
filterOptions.stats = {
  totalAnime: catalog.length,
  totalSeries: series.length,
  totalMovies: movies.length,
  genreCount: sortedSeriesGenres.length,
  movieGenreCount: sortedMovieGenres.length,
  seasonCount: sortedSeasons.length,
  ongoingCount: ongoing.length
};

// Save filter options
const filterOptionsPath = path.join(DATA_DIR, 'filter-options.json');
fs.writeFileSync(filterOptionsPath, JSON.stringify(filterOptions, null, 2));

console.log('\n=== Filter Options Regenerated ===');
console.log(`Total anime: ${catalog.length}`);
console.log(`  Series: ${series.length}`);
console.log(`  Movies: ${movies.length}`);
console.log(`\nSeries genres: ${sortedSeriesGenres.length}`);
console.log(`  Top 5: ${sortedSeriesGenres.slice(0, 5).map(([g, c]) => `${g}(${c})`).join(', ')}`);
console.log(`\nMovie genres: ${sortedMovieGenres.length}`);
console.log(`  Top 5: ${sortedMovieGenres.slice(0, 5).map(([g, c]) => `${g}(${c})`).join(', ')}`);
console.log(`\nSeasons: ${sortedSeasons.length}`);
console.log(`  Latest: ${sortedSeasons.slice(0, 3).map(([s]) => s).join(', ')}`);
console.log(`\nWeekdays: ${sortedWeekdays.length}`);
console.log(`  ${sortedWeekdays.map(([d, c]) => `${d}(${c})`).join(', ')}`);
console.log(`\nSaved to: ${filterOptionsPath}`);
