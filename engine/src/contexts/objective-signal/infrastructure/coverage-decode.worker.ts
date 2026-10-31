/** Worker module of the coverage read. A worker resolves no path alias, so everything it imports is imported by relative path. */

import { serveBytesWith } from "../../../shared-infrastructure/worker/serve-bytes.ts";
import { openDecoder, type DecodeContext } from "./coverage-decode.ts";

serveBytesWith<DecodeContext>(openDecoder);
