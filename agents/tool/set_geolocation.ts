import { tool } from "@opencode-ai/plugin";
import { callGeolocation } from "../lib/geolocation-client.mjs";

// `set_geolocation`: the authoring roles move the location the orchestrator's authenticated browser opens pages at, and the
// location their prompts state. It is authoring context, never an input the delivered suite has: a spec that depends on a
// location pins it with the suite's setLocation() helper. The orchestrator owns the value and every limit; nothing runs here.
// Loaded from the global config directory only: the project configuration of a watched repo is ignored by the server.

export default tool({
  description:
    "Set the device location of this authoring run's authenticated browser. Give a place the app declares, or a latitude and longitude. " +
    "The answer names the scope it moved (the run, or this flow) and the resolved coordinates; navigate or reload after it so the page reads the new position. The suite does not use this value: a spec that depends on a location must call setLocation(context, latitude, longitude) from the suite's fixtures. " +
    "Use it only when your task states the device location of the authoring run.",
  args: {
    place: tool.schema.string().optional().describe("The name of a place the app declares (for example: barcelona)."),
    latitude: tool.schema.number().optional().describe("A latitude from -90 to 90, with a longitude."),
    longitude: tool.schema.number().optional().describe("A longitude from -180 to 180, with a latitude."),
  },
  async execute(args, context) {
    return callGeolocation({ args, context, env: process.env });
  },
});
