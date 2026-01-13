const databaseLoader = require('../src/utils/databaseLoader');

async function main() {
  await databaseLoader.loadDatabase();
  const catalog = databaseLoader.getCatalog();
  
  // Find all Demon Slayer entries
  const demonSlayer = catalog.filter(a => 
    (a.name && a.name.toLowerCase().includes('demon slayer')) ||
    (a.name && a.name.toLowerCase().includes('kimetsu'))
  );
  
  console.log('Demon Slayer entries found:', demonSlayer.length);
  demonSlayer.forEach(a => {
    console.log(`\n${a.name}`);
    console.log(`  ID: ${a.id}`);
    console.log(`  IMDB: ${a.imdb_id}`);
    console.log(`  Type: ${a.type}`);
    console.log(`  Subtype: ${a.subtype}`);
    console.log(`  Runtime: ${a.runtime || 'N/A'} min`);
    console.log(`  Episodes: ${a.episodeCount || 'N/A'}`);
    console.log(`  Status: ${a.status}`);
    console.log(`  Year: ${a.year}`);
    console.log(`  Season: ${a.season || 'N/A'}`);
  });
}

main().catch(console.error);
