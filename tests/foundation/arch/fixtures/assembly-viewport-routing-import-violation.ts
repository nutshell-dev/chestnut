/**
 * phase 1279 Step A boundary fixture: simulates an Assembly module illegally
 * importing the CLIProcess viewport routing owner. Intentionally violates the
 * Assembly zero-viewport-routing rule for scanner verification.
 */

import { VIEWPORT_FILE_ROUTING } from '../../../src/viewport/viewport-audit-events.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void VIEWPORT_FILE_ROUTING;
