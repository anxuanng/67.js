/**
 * Wording for the agent errors that recorded runs hit most. The session errors alone were a third of all tool errors
 * (21 of 68): an agent used an ID it invented, or one from a scene that was disposed or never created.
 */
export function sessionProblem(requestedSessionId, activeSessionId) {
  if (!activeSessionId) {
    return 'No scene is active: it was never created, was disposed, or scene_create failed. Call scene_create or scene_create_asset first, then pass the sessionId it returns.';
  }
  return `Unknown scene session ${requestedSessionId}. The active session is ${activeSessionId}; pass that sessionId, or call scene_dispose and then scene_create for a new scene.`;
}
