const databaseLoader = require('../src/utils/databaseLoader');

async function main() {
  await databaseLoader.loadDatabase();
  
  const catalog = databaseLoader.getCatalog();
  console.log(`\nTotal anime in catalog: ${catalog.length}`);
  
  // Check status values
  const statuses = {};
  catalog.forEach(a => { 
    statuses[a.status || 'undefined'] = (statuses[a.status || 'undefined'] || 0) + 1; 
  });
  console.log('Status counts:', statuses);
  
  const airing = catalog.filter(a => a.status === 'ONGOING');
  console.log(`Total airing (ONGOING): ${airing.length}`);

  const current = catalog.filter(a => a.status === 'current');
  console.log(`Total current: ${current.length}`);
  
  // Check broadcastDay field  
  const withBroadcastDay = catalog.filter(a => a.broadcastDay);
  console.log(`With broadcastDay: ${withBroadcastDay.length}`);

  // Sample some anime to see what fields they have
  console.log('\nSample anime:');
  catalog.slice(0, 3).forEach(a => {
    console.log(`  ${a.title}`);
    console.log(`    status: ${a.status}`);
    console.log(`    broadcastDay: ${a.broadcastDay || 'N/A'}`);
    console.log(`    season: ${a.season}`);
    console.log(`    year: ${a.year}`);
  });

  // Count by weekday
  const weekdayCounts = {};
  withBroadcastDay.forEach(a => {
    const day = a.broadcastDay.toLowerCase();
    weekdayCounts[day] = (weekdayCounts[day] || 0) + 1;
  });
  console.log('\nBroadcast day counts:', weekdayCounts);
}

main().catch(console.error);
