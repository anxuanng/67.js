// Square tiles over an area that pick a level of detail from the camera distance and rebuild only when it changes.
// Grass and ground clutter share it: each supplies `buildParts(tile, levelIndex)` and gets streamable parts back.

const HYSTERESIS = 1.1;

/** Stable 32-bit hash of a tile (or any integer cell) and a seed. */
export function hashTile(seed, column, row) {
  let mixed = Math.imul(column + 7919, 374761393) ^ Math.imul(row - 104729, 668265263) ^ Math.imul(seed, 2246822519);
  mixed = Math.imul(mixed ^ mixed >>> 13, 1274126177);
  return (mixed ^ mixed >>> 16) >>> 0;
}

/** Translation matrix that places tile-local geometry at the tile's corner. */
export function tileMatrix(tile) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tile.tileX, 0, tile.tileZ, 1]);
}

/**
 * `levels` is a list of `{ distance }` from near to far; tiles past `cullDistance` are dropped.
 * `buildParts(tile, levelIndex)` returns the tile's parts at that level (an empty array is fine).
 * A tile keeps `tile.cache` between rebuilds for whatever the caller wants to plan once.
 */
export function createTileField({ area, tileSize, levels, cullDistance, terrainHeight, buildParts }) {
  const columns = Math.ceil((area.maxX - area.minX) / tileSize);
  const rows = Math.ceil((area.maxZ - area.minZ) / tileSize);
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const tileX = area.minX + column * tileSize;
      const tileZ = area.minZ + row * tileSize;
      const centerX = tileX + tileSize / 2;
      const centerZ = tileZ + tileSize / 2;
      tiles.push({ column, row, tileX, tileZ, centerX, centerZ, centerY: terrainHeight(centerX, centerZ), level: -1, cache: {}, parts: [] });
    }
  }

  function levelFor(tile, eye) {
    const distance = Math.max(0, Math.hypot(eye[0] - tile.centerX, eye[1] - tile.centerY, eye[2] - tile.centerZ) - tileSize * 0.5);
    if (distance > cullDistance) return -1;
    let target = levels.findIndex(level => distance <= level.distance);
    if (target === -1) target = levels.length - 1;
    // Hysteresis: a tile only moves to a coarser level once it is clearly past the boundary, so tiles on an edge do not flicker.
    if (tile.level >= 0 && target > tile.level && distance <= levels[tile.level].distance * HYSTERESIS) return tile.level;
    return target;
  }

  let visibleParts = [];
  function update(eye) {
    if (!eye || eye.length < 3 || ![eye[0], eye[1], eye[2]].every(Number.isFinite)) throw new TypeError('update needs an eye position [x, y, z].');
    let changed = false;
    for (const tile of tiles) {
      const target = levelFor(tile, eye);
      if (target === tile.level) continue;
      changed = true;
      tile.level = target;
      tile.parts = target === -1 ? [] : buildParts(tile, target);
    }
    if (changed) visibleParts = tiles.flatMap(tile => tile.parts);
    return changed;
  }

  function stats() {
    const levelCounts = levels.map(() => 0);
    let visibleTiles = 0;
    let triangles = 0;
    let vertices = 0;
    for (const tile of tiles) {
      if (tile.parts.length === 0) continue;
      visibleTiles += 1;
      levelCounts[tile.level] += 1;
      for (const part of tile.parts) {
        triangles += part.geometry.indices.length / 3;
        vertices += part.geometry.positions.length / 3;
      }
    }
    // Position, normal, uv and colour floats per vertex, three 32-bit indices per triangle.
    return { tiles: tiles.length, visibleTiles, levelCounts, triangles, vertices, geometryBytes: vertices * 11 * 4 + triangles * 12 };
  }

  return { get parts() { return visibleParts; }, update, stats };
}
