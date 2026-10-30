/** Worker module of the coverage harvest. A worker resolves no path alias, so the sanitizer is imported by relative path. */

import { sanitizeV8Dump } from "../../objective-signal/domain/dump-sanitizers.ts";
import { serveBytes } from "../../../shared-infrastructure/worker/serve-bytes.ts";

serveBytes(sanitizeV8Dump);
