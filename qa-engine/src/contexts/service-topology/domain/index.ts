/* Cross-repo boundary domain. Transport-agnostic VOs. ServiceSymbolRef (cross-repo) is distinct from LocalSymbolRef (intra-repo). Profile types are the config contract an app supplies — nothing app-specific belongs in engine core. */

/** Identifies a repo and the filesystem path to its working copy. */
export interface RepoRef {
  repo: string;
  mirrorDir: string;
}

/** Cross-repo symbol reference. Only used in service-topology — NOT the same as LocalSymbolRef. */
export interface ServiceSymbolRef {
  repo: string;
  file: string;
  symbol: string;
}

/** A resolved cross-repo dependency link. Transport is open-union; the domain treats it as opaque. */
export interface ServiceLink {
  from: ServiceSymbolRef;
  to: ServiceSymbolRef;
  transport: "http" | "event" | "rpc";
  contractRef?: string;
  confidence: number;
  source: string;
}

/** A detected FE↔BE contract drift: the frontend calls an endpoint the backend contract does not declare. */
export interface ContractDrift {
  from: ServiceSymbolRef;
  verb: string;
  path: string;
}

/** A call-site that targets a service outside the indexed repo set. */
export interface ExternalCall {
  path: string;
  verb: string;
  from?: ServiceSymbolRef;
}
/** A call-site whose path argument could not be statically resolved (dynamic or method-param expression). */
export interface UnresolvedCall {
  rawArg: string;
  file: string;
}

/** Identifies a call-site SHAPE (a key into the in-core CallSiteCatalog) plus the concrete receiver an app's code uses for that shape. The shape lives in the core; the receiver is config, never hardcoded. */
export interface CallSiteRef {
  kind: string;
  receiver?: string;
}

/** Identifies a BE→BE HTTP call-pattern SHAPE (a key into the in-core CallPatternCatalog) plus the optional receiver an app's code uses for that shape. Sibling of CallSiteRef (FE HTTP) and EventPatternRef (events). The shape lives in the core; the receiver is config, never hardcoded. */
export interface CallPatternRef {
  kind: string;
  receiver?: string;
}

/** An app's HTTP boundary convention: how its frontend calls its backends, and where each backend's OpenAPI contract lives. One HttpBoundaryProfile per app, supplied via config. */
export interface HttpBoundaryProfile {
  transport: "http";
  /** Filename-suffix of front egress files (compileFileGlob supports only two shapes). Not a full glob: the directory walk already recurses and only tests a bare filename. Any other shape warns and matches no files (fail-closed). */
  frontFiles: string;
  frontCallSite: CallSiteRef;
  servicePrefixTemplate: string;
  serviceRepoTemplate: string;
  openApiPath: string;
}

/** Identifies an EVENT call-site SHAPE (a key into the in-core event-pattern catalog) plus the concrete class/method names an app's code uses for that shape. The shape lives in the core catalog; every concrete symbol name is config, never hardcoded. */
export interface EventPatternRef {
  kind: string;
  listenerBaseType: string;
  listenerEventCall: string;
  subscriberBaseType: string;
  publishCall: string;
}

/** An app's EVENT boundary convention: how its backend repos publish/consume domain events (the transport is opaque to this profile; only the class/method SHAPE matters). One EventBoundaryProfile per app, supplied via config. */
export interface EventBoundaryProfile {
  transport: "event";
  files: string;
  eventPattern: EventPatternRef;
}

/** An app's BE→BE HTTP boundary convention: how one backend calls another over HTTP, and where each target's OpenAPI contract lives. One HttpBackendBoundaryProfile per app, supplied via config. FE→BE HTTP stays HttpBoundaryProfile — this transport scans backend repos, not frontend egress files. */
export interface HttpBackendBoundaryProfile {
  transport: "http-backend";
  sourceFiles: string;
  callPattern: CallPatternRef;
  servicePrefixTemplate: string;
  serviceRepoTemplate: string;
  openApiPath: string;
}

/** Open union of boundary profiles, discriminated by `transport`. A future transport adds a sibling variant here, never a branch in the core — widening the union forces resolver-factory.ts to register a new builder. */
export type BoundaryProfile = HttpBoundaryProfile | EventBoundaryProfile | HttpBackendBoundaryProfile;
