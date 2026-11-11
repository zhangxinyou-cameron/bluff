const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function readRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

function writeRecord(directory, id, record) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, id + '.json');
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', flush: true, mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function deleteRecord(directory, id) {
  fs.rmSync(path.join(directory, id + '.json'), { force: true });
}

module.exports = { readRecords, writeRecord, deleteRecord };
