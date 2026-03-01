'use strict';

const fs = require('fs');

/**
 * Parse a cty.dat file into a database of DXCC entities and prefix mappings.
 */
function loadCtyDat(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const entities = [];
  const prefixMap = {};
  const exactMap = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line || line.startsWith(' ') || line.startsWith('\t')) {
      i++;
      continue;
    }

    const parts = line.split(':').map((s) => s.trim());
    if (parts.length < 8) {
      i++;
      continue;
    }

    const entity = {
      name: parts[0],
      cqZone: parseInt(parts[1], 10),
      ituZone: parseInt(parts[2], 10),
      continent: parts[3],
      lat: parseFloat(parts[4]),
      lon: -parseFloat(parts[5]),
      utcOffset: parseFloat(parts[6]),
      prefix: parts[7].replace('*', ''),
    };

    const entIdx = entities.length;
    entities.push(entity);
    prefixMap[entity.prefix.toUpperCase()] = entIdx;

    i++;
    let prefixBlock = '';
    while (i < lines.length) {
      const pl = lines[i];
      if (!pl.startsWith(' ') && !pl.startsWith('\t') && pl.trim().length > 0 && !pl.trim().startsWith(',')) {
        break;
      }
      prefixBlock += pl;
      const done = pl.trimEnd().endsWith(';');
      i++;
      if (done) break;
    }

    prefixBlock = prefixBlock.replace(/;$/, '');
    const prefixes = prefixBlock.split(',').map((p) => p.trim()).filter(Boolean);

    for (const raw of prefixes) {
      let clean = raw.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '').trim();
      if (!clean) continue;

      if (clean.startsWith('=')) {
        exactMap[clean.substring(1).toUpperCase()] = entIdx;
      } else {
        prefixMap[clean.toUpperCase()] = entIdx;
      }
    }
  }

  return { entities, prefixMap, exactMap };
}

/**
 * Resolve a callsign to a DXCC entity using the cty.dat database.
 */
function resolveCallsign(call, db) {
  if (!call || !db) return null;
  const uc = call.toUpperCase().replace(/\/P$|\/M$|\/QRP$|\/MM$|\/AM$/i, '');

  if (db.exactMap[uc] != null) {
    return db.entities[db.exactMap[uc]];
  }

  for (let len = uc.length; len >= 1; len--) {
    const prefix = uc.substring(0, len);
    if (db.prefixMap[prefix] != null) {
      return db.entities[db.prefixMap[prefix]];
    }
  }

  return null;
}

module.exports = { loadCtyDat, resolveCallsign };
