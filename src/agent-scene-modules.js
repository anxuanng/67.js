// Code that most recipes never run loads on demand, so the agent scene entry stays small. A recipe that uses mesh
// editing, procedural modeling, motion or material patterns needs its module loaded before createAgentScene runs:
// call `await loadAgentSceneModules(recipe)` (or `loadAllAgentSceneModules()` in a host that does not mind the
// size). createAgentScene is still synchronous; when a needed module is missing it says which call to make.

const MODULE_LOADERS = {
  mesh: () => import('./agent-mesh-engine.js'),
  modeling: () => import('./modeling.js'),
  text: () => import('./text-geometry.js'),
  motion: () => import('./agent-motion.js'),
  physics: () => import('./agent-physics.js'),
  patterns: () => import('./material-patterns.js'),
  relations: () => import('./agent-relations.js'),
};

const loadedModules = {};
const pendingLoads = {};
let manifoldLoader = null;
let physicsLoader = null;

// Each test errs on the side of loading: a false positive costs a chunk, a false negative a clear error.
const MODULE_MARKERS = {
  mesh: ['"type":"mesh"', '"instances"'],
  modeling: ['"type":"lathe"', '"type":"extrude"', '"type":"tube"', '"type":"curve"'],
  text: ['"type":"text"'],
  motion: ['"motion":{'],
  physics: ['"physics":{'],
  patterns: ['"pattern"'],
  relations: ['"relations":'],
};

/** Whether a recipe, operation list or edit list contains a boolean edit, which needs loadMeshBooleans() first. */
export function needsMeshBooleans(value) {
  return JSON.stringify(value ?? null).includes('"op":"boolean"');
}

/** True when a recipe or an operation list carries a physics section, so the host loads the solver first. */
export function needsPhysics(value) {
  return JSON.stringify(value ?? null).includes('"physics":{');
}

/** Names of the on-demand modules a recipe, or a list of edit operations, needs. */
export function agentSceneModulesNeeded(value) {
  let text;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return Object.keys(MODULE_LOADERS);
  }
  const compact = text.replace(/"\s*:\s*/g, '":');
  return Object.keys(MODULE_MARKERS).filter(name => MODULE_MARKERS[name].some(marker => compact.includes(marker)));
}

function loadModule(name) {
  if (loadedModules[name]) return Promise.resolve(loadedModules[name]);
  pendingLoads[name] ??= MODULE_LOADERS[name]().then(module => {
    loadedModules[name] = module;
    if (name === 'mesh' && manifoldLoader) module.setManifoldModuleLoader(manifoldLoader);
    if (name === 'physics' && physicsLoader) module.setPhysicsModuleLoader(physicsLoader);
    return module;
  });
  return pendingLoads[name];
}

/** Load the modules a recipe (or a list of edit operations) needs. Safe to call repeatedly. */
export async function loadAgentSceneModules(value) {
  await Promise.all(agentSceneModulesNeeded(value).map(loadModule));
}

/** Load every on-demand module, for hosts that run any recipe an agent writes. */
export async function loadAllAgentSceneModules() {
  await Promise.all(Object.keys(MODULE_LOADERS).map(loadModule));
}

/** Entries that import a module statically register it here, so createAgentScene finds it without a load call. */
export function registerAgentSceneModule(name, module) {
  loadedModules[name] ??= module;
}

/** The loaded module, or an error that names the call that loads it. */
export function agentSceneModule(name) {
  const module = loadedModules[name];
  if (!module) {
    throw new Error(`This recipe needs the ${name} code, which loads on demand: await loadAgentSceneModules(recipe) before createAgentScene or apply.`);
  }
  return module;
}

export function allAgentSceneModulesLoaded() {
  return Object.keys(MODULE_LOADERS).every(name => loadedModules[name]);
}

export function agentSceneModuleLoaded(name) {
  return Boolean(loadedModules[name]);
}

/** Add a font table that recipes can name in a text geometry. Loads the text code first. */
export async function registerAgentSceneFont(name, fontData) {
  const module = await loadModule('text');
  module.registerFont(name, fontData);
}

/** Replace how the Manifold module is imported. Applied when the mesh code loads, if it has not yet. */
export function setManifoldModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The Manifold loader must be a function returning a module promise.');
  manifoldLoader = loader;
  loadedModules.mesh?.setManifoldModuleLoader(loader);
}

export async function loadMeshBooleans(options) {
  const mesh = await loadModule('mesh');
  return mesh.loadMeshBooleans(options);
}

export function meshBooleansLoaded() {
  return loadedModules.mesh?.meshBooleansLoaded() ?? false;
}

/** Replace how the Rapier module is imported. Applied when the physics code loads, if it has not yet. */
export function setPhysicsModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The physics loader must be a function returning a module promise.');
  physicsLoader = loader;
  loadedModules.physics?.setPhysicsModuleLoader(loader);
}

export async function loadPhysicsEngine(options) {
  const physics = await loadModule('physics');
  return physics.loadPhysicsEngine(options);
}

export function physicsEngineLoaded() {
  return loadedModules.physics?.physicsEngineLoaded() ?? false;
}
