const catalog = require('./data/catalog.json').catalog;
console.log('Total:', catalog.length);

const ids = ['mal-59978', 'mal-53876', 'mal-62804'];
ids.forEach(id => {
  const anime = catalog.find(a => a.id === id);
  if (anime) {
    console.log('✓', id, '-', anime.name);
  } else {
    console.log('✗ Missing:', id);
  }
});
