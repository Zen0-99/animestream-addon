const https = require('https');

const url = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data/catalog.json?_=' + Date.now();

https.get(url, {
  headers: { 'User-Agent': 'Node.js', 'Cache-Control': 'no-cache' }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    const catalog = json.catalog;
    console.log('GitHub catalog size:', catalog.length);
    
    const ids = ['mal-59978', 'mal-53876', 'mal-62804'];
    ids.forEach(id => {
      const anime = catalog.find(a => a.id === id);
      if (anime) {
        console.log('✓', id, '-', anime.name);
      } else {
        console.log('✗ Missing:', id);
      }
    });
  });
}).on('error', err => console.error('Error:', err));
