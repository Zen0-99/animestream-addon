const databaseLoader = require('../src/utils/databaseLoader');

async function main() {
  await databaseLoader.loadDatabase();
  const sample = databaseLoader.getCatalog()[0];
  console.log('Sample poster URL:', sample.poster);
  console.log('Sample background URL:', sample.background);
  
  // Check different size options
  if (sample.poster) {
    const base = sample.poster.replace(/\/[^/]+\.jpe?g$/, '');
    console.log('\nPossible sizes:');
    console.log('  tiny:', base + '/tiny.jpg');
    console.log('  small:', base + '/small.jpg');
    console.log('  medium:', base + '/medium.jpg');
    console.log('  large:', base + '/large.jpg');
    console.log('  original:', base + '/original.jpg');
  }
}

main().catch(console.error);
