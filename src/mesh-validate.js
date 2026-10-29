// Structural invariants of an EditMesh. Every operator test runs this after each step.

function fail(message) {
  throw new RangeError(`Topology invalid: ${message}`);
}

function checkVertices(edit) {
  const edgeSlot = edit.vertices.arrays.edgeSlot;
  const diskNext = edit.edges.arrays.diskNext;
  const diskPrev = edit.edges.arrays.diskPrev;
  const edgeVertex = edit.edges.arrays.vertex;
  const slotLimit = edit.edges.count * 2;
  let diskSlots = 0;
  for (const vertex of edit.liveIndices('point')) {
    const first = edgeSlot[vertex];
    if (first === -1) continue;
    let slot = first;
    let steps = 0;
    do {
      if (slot < 0 || slot >= slotLimit || edit.edges.removed[slot >> 1]) fail(`vertex ${vertex} disk reaches a removed or missing edge.`);
      if (edgeVertex[slot] !== vertex) fail(`vertex ${vertex} disk contains edge ${slot >> 1}, which does not use it.`);
      if (diskPrev[diskNext[slot]] !== slot) fail(`vertex ${vertex} disk links are not symmetric at edge ${slot >> 1}.`);
      steps++;
      if (steps > slotLimit) fail(`vertex ${vertex} disk cycle does not close.`);
      slot = diskNext[slot];
    } while (slot !== first);
    diskSlots += steps;
  }
  return diskSlots;
}

function checkEdges(edit, diskSlots) {
  const edgeVertex = edit.edges.arrays.vertex;
  const edgeLoop = edit.edges.arrays.loop;
  const loopArrays = edit.loops.arrays;
  let radialLoops = 0;
  let liveEdges = 0;
  for (const edge of edit.liveIndices('edge')) {
    liveEdges++;
    const first = edgeVertex[edge * 2];
    const second = edgeVertex[edge * 2 + 1];
    if (!edit.vertices.isLive(first) || !edit.vertices.isLive(second)) fail(`edge ${edge} uses a removed vertex.`);
    if (first === second) fail(`edge ${edge} is a loop on vertex ${first}.`);
    if (edit.findEdge(first, second) !== edge) fail(`edge ${edge} duplicates another edge between ${first} and ${second}.`);
    const firstLoop = edgeLoop[edge];
    if (firstLoop === -1) continue;
    let loop = firstLoop;
    let steps = 0;
    do {
      if (!edit.loops.isLive(loop)) fail(`edge ${edge} radial cycle reaches a removed loop.`);
      if (loopArrays.edge[loop] !== edge) fail(`edge ${edge} radial cycle contains loop ${loop} of edge ${loopArrays.edge[loop]}.`);
      if (loopArrays.radialPrev[loopArrays.radialNext[loop]] !== loop) fail(`edge ${edge} radial links are not symmetric.`);
      steps++;
      if (steps > edit.loops.count) fail(`edge ${edge} radial cycle does not close.`);
      loop = loopArrays.radialNext[loop];
    } while (loop !== firstLoop);
    radialLoops += steps;
  }
  if (diskSlots !== liveEdges * 2) fail(`disk cycles hold ${diskSlots} edge ends, expected ${liveEdges * 2}.`);
  return radialLoops;
}

function checkFaces(edit, radialLoops) {
  const loopArrays = edit.loops.arrays;
  let faceLoops = 0;
  // Last face that visited each vertex, to find repeated vertices without a Set per face.
  const visitedByFace = new Int32Array(edit.vertices.count).fill(-1);
  for (const face of edit.liveIndices('face')) {
    const first = edit.faces.arrays.loop[face];
    const size = edit.faces.arrays.size[face];
    if (size < 3) fail(`face ${face} has ${size} corners.`);
    let loop = first;
    let steps = 0;
    do {
      if (!edit.loops.isLive(loop)) fail(`face ${face} reaches a removed loop.`);
      if (loopArrays.face[loop] !== face) fail(`face ${face} contains loop ${loop} of face ${loopArrays.face[loop]}.`);
      if (loopArrays.prev[loopArrays.next[loop]] !== loop) fail(`face ${face} loop links are not symmetric.`);
      const vertex = loopArrays.vertex[loop];
      const nextVertex = loopArrays.vertex[loopArrays.next[loop]];
      const edge = loopArrays.edge[loop];
      const edgeFirst = edit.edges.arrays.vertex[edge * 2];
      const edgeSecond = edit.edges.arrays.vertex[edge * 2 + 1];
      const joins = (edgeFirst === vertex && edgeSecond === nextVertex) || (edgeFirst === nextVertex && edgeSecond === vertex);
      if (!joins) fail(`face ${face} loop ${loop} edge ${edge} does not join vertices ${vertex} and ${nextVertex}.`);
      if (visitedByFace[vertex] === face) fail(`face ${face} repeats vertex ${vertex}.`);
      visitedByFace[vertex] = face;
      steps++;
      if (steps > size) fail(`face ${face} has more loops than its size ${size}.`);
      loop = loopArrays.next[loop];
    } while (loop !== first);
    if (steps !== size) fail(`face ${face} has ${steps} loops but size ${size}.`);
    faceLoops += steps;
  }
  if (faceLoops !== edit.loops.liveCount) fail(`faces own ${faceLoops} loops but ${edit.loops.liveCount} are live.`);
  if (radialLoops !== faceLoops) fail(`radial cycles hold ${radialLoops} loops but faces own ${faceLoops}.`);
}

/**
 * Check every link of an EditMesh. Throws RangeError naming the first broken element.
 * Returns counts and the Euler characteristic V - E + F.
 */
export function validateTopology(edit) {
  const diskSlots = checkVertices(edit);
  const radialLoops = checkEdges(edit, diskSlots);
  checkFaces(edit, radialLoops);
  return {
    vertices: edit.vertexCount,
    edges: edit.edgeCount,
    faces: edit.faceCount,
    loops: edit.loopCount,
    euler: edit.vertexCount - edit.edgeCount + edit.faceCount,
  };
}
