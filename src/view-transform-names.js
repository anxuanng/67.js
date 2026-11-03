// The names a recipe may use, kept apart from the curves so that validating a recipe does not pull the curves in.

/** Display transforms: aces is the built-in curve and the default. */
export const VIEW_TRANSFORM_NAMES = Object.freeze(['aces', 'agx', 'neutral']);

/** Looks a recipe can name. They are built in code, so no file path crosses the recipe or the MCP boundary. */
export const LOOK_NAMES = Object.freeze(['warm', 'cool', 'contrast', 'faded']);
