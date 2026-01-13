const databaseLoader = require('../src/utils/databaseLoader');

async function main() {
  await databaseLoader.loadDatabase();
  const catalog = databaseLoader.getCatalog();
  
  const movies = catalog.filter(a => a.subtype === 'movie');
  const upcoming = movies.filter(a => a.status !== 'FINISHED').length;
  const currentYear = new Date().getFullYear();
  const newReleases = movies.filter(a => a.year >= currentYear - 1 && a.status === 'FINISHED').length;
  
  console.log('Total movies:', movies.length);
  console.log('Upcoming:', upcoming);
  console.log('New Releases:', newReleases);
  
  // Check current year distribution
  console.log('\nMovies by year:');
  const byYear = {};
  movies.forEach(m => {
    byYear[m.year || 'unknown'] = (byYear[m.year || 'unknown'] || 0) + 1;
  });
  Object.entries(byYear).sort((a, b) => b[0] - a[0]).slice(0, 10).forEach(([y, c]) => {
    console.log(`  ${y}: ${c}`);
  });
  
  // Check movie genres
  console.log('\nMovie genres (top 10):');
  const genreCounts = {};
  movies.forEach(m => {
    (m.genres || []).forEach(g => {
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    });
  });
  Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([g, c]) => {
    console.log(`  ${g}: ${c}`);
  });
}

main().catch(console.error);
