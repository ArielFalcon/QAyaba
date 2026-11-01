// The typed arguments of the submit tools. Each tool's arguments are the JSON Schema the owning context's wire schema renders to
// (agents/lib/submit-contracts.json, written by `npm run submit-contracts:gen`); this file turns that schema into the zod types a
// tool declares, with `z` injected (OpenCode's `tool.schema`). Plain JavaScript so it is tested without OpenCode
// (agents/lib/submit-schema.test.mjs). A schema keyword it does not know throws at load, so a wire that starts using one breaks
// the tool visibly instead of being shown to the model as something looser than the orchestrator checks.

const ANNOTATIONS = new Set(["description", "default"]);
const KEYWORDS = {
  object: new Set(["type", "properties", "required", ...ANNOTATIONS]),
  array: new Set(["type", "items", ...ANNOTATIONS]),
  string: new Set(["type", "minLength", ...ANNOTATIONS]),
  number: new Set(["type", "minimum", "maximum", "exclusiveMinimum", ...ANNOTATIONS]),
  integer: new Set(["type", "minimum", "maximum", "exclusiveMinimum", ...ANNOTATIONS]),
  boolean: new Set(["type", ...ANNOTATIONS]),
  null: new Set(["type", ...ANNOTATIONS]),
  enum: new Set(["enum", "type", ...ANNOTATIONS]),
  const: new Set(["const", "type", ...ANNOTATIONS]),
  union: new Set(["anyOf", "oneOf", ...ANNOTATIONS]),
};

function refuse(path, why) {
  throw new Error(`submit-schema: ${path || "(root)"}: ${why}`);
}

function kindOf(node, path) {
  if (node.const !== undefined) return "const";
  if (node.enum !== undefined) return "enum";
  if (node.anyOf !== undefined || node.oneOf !== undefined) return "union";
  if (typeof node.type === "string" && KEYWORDS[node.type]) return node.type;
  return refuse(path, `no supported type in ${JSON.stringify(Object.keys(node))}`);
}

function build(z, node, path) {
  if (node === null || typeof node !== "object") refuse(path, "a schema must be an object");
  const kind = kindOf(node, path);
  for (const keyword of Object.keys(node)) if (!KEYWORDS[kind].has(keyword)) refuse(path, `unsupported keyword "${keyword}"`);
  let out;
  switch (kind) {
    case "const":
      out = z.literal(node.const);
      break;
    case "enum":
      out = node.enum.length === 1 ? z.literal(node.enum[0]) : z.union(node.enum.map((value) => z.literal(value)));
      break;
    case "union": {
      const options = (node.anyOf ?? node.oneOf).map((option, at) => build(z, option, `${path}|${at}`));
      out = options.length === 1 ? options[0] : z.union(options);
      break;
    }
    case "object": {
      const required = new Set(node.required ?? []);
      const shape = {};
      for (const [name, property] of Object.entries(node.properties ?? {})) {
        const built = build(z, property, path ? `${path}.${name}` : name);
        shape[name] = required.has(name) ? built : built.optional();
      }
      out = z.object(shape);
      break;
    }
    case "array":
      out = z.array(build(z, node.items ?? refuse(path, "an array declares its items"), `${path}[]`));
      break;
    case "string":
      out = z.string();
      if (node.minLength !== undefined) out = out.min(node.minLength);
      break;
    case "number":
    case "integer":
      out = node.type === "integer" ? z.number().int() : z.number();
      if (node.minimum !== undefined) out = out.min(node.minimum);
      if (node.maximum !== undefined) out = out.max(node.maximum);
      if (node.exclusiveMinimum !== undefined) out = out.gt(node.exclusiveMinimum);
      break;
    case "boolean":
      out = z.boolean();
      break;
    default:
      out = z.null();
  }
  return typeof node.description === "string" ? out.describe(node.description) : out;
}

// The zod shape of a tool's arguments: the schema's properties, the optional ones marked so.
export function argsShapeOf(z, schema) {
  if (schema?.type !== "object") refuse("", "a tool's arguments are an object");
  return build(z, schema, "").shape;
}
