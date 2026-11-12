const fs = require('node:fs');
const path = require('node:path');

const builtInFlags = [
  { id: 'pine', name: '松林斜带' },
  { id: 'tide', name: '深海星旗' },
  { id: 'ember', name: '赤焰三纹' },
  { id: 'violet', name: '紫夜菱旗' },
  { id: 'dune', name: '沙丘日旗' },
  { id: 'frost', name: '冰川燕尾' },
  { id: 'onyx', name: '黑金四格' },
  { id: 'bronze', name: '青铜环旗' }
];
const defaultFlagId = builtInFlags[0].id;
const types = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);

function customFlags(directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isFile()).map(entry => {
    const extension = path.extname(entry.name);
    const type = types.get(extension.toLowerCase());
    if (!type) return null;
    const id = 'file:' + entry.name;
    return { id, name: path.basename(entry.name, extension), type, file: path.join(directory, entry.name) };
  }).filter(Boolean);
}

function flagCatalog(directory) {
  return [...builtInFlags, ...customFlags(directory).map(({ id, name }) => ({
    id, name, src: '/api/team-flags?id=' + encodeURIComponent(id)
  }))];
}

module.exports = { flagCatalog, customFlags, defaultFlagId };
