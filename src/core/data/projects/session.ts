// What the stable session id and session transfer (core/session) need of a project: the id record
// (session-id.ts), the display-name rule shared with /rename, and the checkout validation a new project is bound with.
export { ensureSessionId, readSession, validSessionId, writeSession, type SessionFile } from "./session-id";
export { validDisplayName } from "./registry";
export { validateProjectDirectory } from "./workspace";
