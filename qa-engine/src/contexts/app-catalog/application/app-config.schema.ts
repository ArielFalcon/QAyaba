import { z } from "zod";
import { MAX_PLACES, MAX_PLACE_NAME_CHARS, PLACE_NAME_PATTERN } from "@kernel/geolocation.ts";
import { compileEgressPolicy, EgressPolicyError, originOf } from "@kernel/egress-policy.ts";
import { mutatingEntryError, routePatternError } from "@contexts/test-execution/application/index.ts";
import { isPageOfTemplate } from "@contexts/generation/application/index.ts";
import { LoginPathSchema } from "../domain/login-path.ts";
import { isRepoSlug } from "../domain/repo-slug.ts";

/*
 * A list of origins the execution sandbox may reach (`scheme://host[:port]`, or `scheme://*.suffix[:port]`). Each is compiled
 * here, so an origin the egress filter would refuse is refused when the config is loaded, not when the first run starts.
 */
const OriginListSchema = z.array(z.string().min(1)).superRefine((origins, ctx) => {
  origins.forEach((origin, index) => {
    try {
      compileEgressPolicy([origin]);
    } catch (err) {
      if (!(err instanceof EgressPolicyError)) throw err;
      ctx.addIssue({ code: "custom", message: err.message, path: [index] });
    }
  });
});

/* A list of strings each checked by `check` (which returns what is wrong with one, or undefined): a bad entry is refused when the config is loaded. */
const checkedList = (check: (entry: string) => string | undefined) =>
  z.array(z.string().min(1)).max(100).superRefine((entries, ctx) => {
    entries.forEach((entry, index) => {
      const problem = check(entry);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: `${JSON.stringify(entry)} ${problem}`, path: [index] });
    });
  });

/*
 * ── boundaries[] schema (Stitcher → Generation seam) ──────────────────────────
 * SHALLOW by design: deep per-entry validation (catalog keys, blank-string rejection,
 * transport dispatch) is owned by YamlBoundaryProfileAdapter (qa-engine service-topology),
 * which re-reads the YAML itself. This schema exists ONLY to (a) stop config-loader
 * stripping the block, (b) give AppConfig.boundaries a shape the factory gates
 * ACTIVE-supply on. Do NOT re-encode the adapter's field lists here — a divergent
 * schema would drift from the adapter's authoritative rules (two validators for one
 * block is the exact anti-pattern this design forbids). Field names below are copied
 * VERBATIM from YamlBoundaryProfileAdapter's required-string-field lists and its
 * HttpBoundaryProfile/EventBoundaryProfile/HttpBackendBoundaryProfile domain interfaces.
 */
const HttpBoundarySchema = z.object({
  transport: z.literal("http"),
  frontFiles: z.string().min(1),
  frontCallSite: z.object({ kind: z.string().min(1), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string().min(1),
  serviceRepoTemplate: z.string().min(1),
  openApiPath: z.string().min(1),
});
const EventBoundarySchema = z.object({
  transport: z.literal("event"),
  files: z.string().min(1),
  eventPattern: z.object({
    kind: z.string().min(1),
    listenerBaseType: z.string().min(1),
    listenerEventCall: z.string().min(1),
    subscriberBaseType: z.string().min(1),
    publishCall: z.string().min(1),
  }),
});
const HttpBackendBoundarySchema = z.object({
  transport: z.literal("http-backend"),
  sourceFiles: z.string().min(1),
  callPattern: z.object({ kind: z.string().min(1), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string().min(1),
  serviceRepoTemplate: z.string().min(1),
  openApiPath: z.string().min(1),
});
/*
 * discriminatedUnion on `transport` mirrors BoundaryProfile's own open-union discrimination
 * (service-topology domain/index.ts) — a future `rpc` transport widens BOTH this union and
 * the adapter's dispatch registry, the same extension seam resolver-factory.ts already uses.
 */
const BoundarySchema = z.discriminatedUnion("transport", [
  HttpBoundarySchema,
  EventBoundarySchema,
  HttpBackendBoundarySchema,
]);

/* A browser position (Playwright's geolocation): the shape dev.geolocation and each of its named places share. */
const GeoPointSchema = z.object({
  latitude: z.number().min(-90, { error: "latitude must be between -90 and 90" }).max(90, { error: "latitude must be between -90 and 90" }),
  longitude: z.number().min(-180, { error: "longitude must be between -180 and 180" }).max(180, { error: "longitude must be between -180 and 180" }),
});

/*
 * ── AppConfig schema ──────────────────────────────────────────────────────────
 * Validates YAML config loaded from config/apps/<name>.yaml. Replaces the unsafe
 * `parse(raw) as AppConfig` cast with runtime validation.
 */
export const AppConfigSchema = z
  .object({
    name: z.string().min(1, { error: "app name is required" }),
    repo: z.string().min(1, { error: "repo is required (e.g. 'org/repo')", abort: true }).refine(isRepoSlug, { error: "repo must be parts joined by '/', none of them . or .. or starting with a dash (e.g. 'org/repo')" }),
    baseBranch: z.string().optional(),
    openapi: z.union([z.string(), z.array(z.string())]).optional(),
    /*
     * `services` (e2e apps only): the microservice repos that participate in this
     * app's flows. A deploy-event webhook from one of these repos triggers an e2e
     * run of THIS app with the service's diff as blast radius. openapi is a glob
     * INSIDE the service repo; versionUrl is an optional deploy-verification belt.
     */
    services: z
      .array(
        z.object({
          repo: z.string().min(1, { error: "service repo is required (e.g. 'org/svc')", abort: true }).refine(isRepoSlug, { error: "service repo must be parts joined by '/', none of them . or .. or starting with a dash (e.g. 'org/svc')" }),
          baseBranch: z.string().optional(),
          openapi: z.union([z.string(), z.array(z.string())]).optional(),
          versionUrl: z.url().optional(),
          pollIntervalMs: z.number().int().positive().optional(),
          deployTimeoutMs: z.number().int().positive().optional(),
        }),
      )
      .optional(),
    /* `dev` is the live site every run tests: required, so every reader holds it. */
    dev: z
      .object({
        baseUrl: z.url({ error: "dev.baseUrl must be a valid URL" }),
        versionUrl: z.url().optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        deployTimeoutMs: z.number().int().positive().optional(),
        /*
         * Origins the agent-written specs may reach besides baseUrl's own (an identity provider, an API host, a CDN the app's
         * pages load from). Everything else is refused by the execution sandbox's egress filter and listed in the run's
         * gate signals, so an app that loads a third-party host declares it here once.
         */
        allowedOrigins: OriginListSchema.optional(),
        /*
         * Origins the app leaves blocked on purpose (telemetry, analytics, ads): the filter refuses them like any undeclared host,
         * and a refusal of one is never taken as the reason a login failed. Declaring one does not open it.
         */
        blockedOrigins: OriginListSchema.optional(),
        /*
         * The browser position a suite and the Context Pack are given (Playwright's geolocation), and the places the authoring
         * agent may name when it moves that position at runtime. Optional: an app that does not depend on where the user is keeps
         * the seed's default and no run carries an authoring location. The position is app data, never a fact the engine infers.
         */
        geolocation: GeoPointSchema.extend({
          places: z
            .record(
              z.string().max(MAX_PLACE_NAME_CHARS, { error: `a place name is at most ${MAX_PLACE_NAME_CHARS} characters` }).regex(PLACE_NAME_PATTERN, { error: "a place name is a lowercase slug (letters, digits and dashes)" }),
              GeoPointSchema,
            )
            .refine((places) => Object.keys(places).length <= MAX_PLACES, { error: `at most ${MAX_PLACES} places are allowed` })
            .optional(),
        }).optional(),
        /*
         * Capture-time data-state readiness. Per route path, selectors the DOM capture reads after the page settles so an
         * empty tree is not mistaken for truth: `readySelector` must appear for the page to be ready; `resultSelector` /
         * `resultTextSelector` count results (a result of 0 read twice on a settled page, with no data request in flight and the tree unchanged, is a confirmed empty state; otherwise it is unconfirmed and retried once); `locationSelector` reads the
         * effective location the page shows. A key ending `/*` names a prefix and its root. Selectors are app data, never a
         * fact the engine infers.
         */
        dataState: z
          .object({
            routes: z
              .record(
                z.string().min(1),
                z.object({
                  readySelector: z.string().min(1, { error: "a data-state selector is non-empty" }).max(200, { error: "a data-state selector is at most 200 characters" }).optional(),
                  resultSelector: z.string().min(1, { error: "a data-state selector is non-empty" }).max(200, { error: "a data-state selector is at most 200 characters" }).optional(),
                  resultTextSelector: z.string().min(1, { error: "a data-state selector is non-empty" }).max(200, { error: "a data-state selector is at most 200 characters" }).optional(),
                  locationSelector: z.string().min(1, { error: "a data-state selector is non-empty" }).max(200, { error: "a data-state selector is at most 200 characters" }).optional(),
                  timeoutMs: z.number().int().min(1, { error: "data-state timeoutMs is a whole number of milliseconds, at least 1" }).max(15_000, { error: "data-state timeoutMs is at most 15000" }).optional(),
                }),
              )
              .refine((routes) => Object.keys(routes).length <= 32, { error: "at most 32 data-state routes are allowed" }),
          })
          .optional(),
        /*
         * A real page per route template of the context map (`/shops/:province/:city/:slug` → `/shops/madrid/madrid/casa-pepe`),
         * which the Context Pack opens when no link the site shows fits the template: an app that navigates by script exposes no
         * link to its detail pages. Each page must fill its template segment by segment. App data, never inferred.
         */
        routeSamples: z
          .record(z.string().min(1).max(512), z.string().min(1).max(512))
          .superRefine((samples, ctx) => {
            if (Object.keys(samples).length > 32) ctx.addIssue({ code: "custom", message: "at most 32 routeSamples are allowed" });
            for (const [template, page] of Object.entries(samples)) {
              if (!isPageOfTemplate(template, page)) {
                ctx.addIssue({ code: "custom", path: [template], message: `routeSamples: ${JSON.stringify(page)} is not a page of the route template ${JSON.stringify(template)}` });
              }
            }
          })
          .optional(),
      }, { error: (issue) => (issue.input === undefined ? "dev is required" : undefined) })
      .superRefine((dev, ctx) => {
        if (dev.blockedOrigins === undefined) return;
        /* An origin that is both reachable and blocked on purpose says two things at once; the app's own origin is reachable by definition. */
        const own = originOf(dev.baseUrl);
        let reachable;
        try {
          reachable = compileEgressPolicy([...(dev.allowedOrigins ?? []), ...(own ? [own] : [])]);
        } catch {
          return; /* OriginListSchema has said what is wrong with allowedOrigins */
        }
        dev.blockedOrigins.forEach((origin, index) => {
          let blocked;
          try {
            blocked = compileEgressPolicy([origin]);
          } catch {
            return; /* OriginListSchema has said what is wrong with it */
          }
          const contradicts = blocked.rules.some((rule) => reachable.allowsName(rule.host)) || reachable.rules.some((rule) => blocked.allowsName(rule.host));
          if (contradicts) ctx.addIssue({ code: "custom", message: `dev.blockedOrigins ${JSON.stringify(origin)} is also reachable (dev.allowedOrigins or the app's own origin): an origin is one or the other`, path: ["blockedOrigins", index] });
        });
      }),
    /*
     * Extra origins for the e2e project's `npm ci`, on top of the registries in config/egress/registries.yaml: a private
     * registry or mirror.
     */
    egress: z.object({ installOrigins: OriginListSchema.optional() }).optional(),
    qa: z.object({
      needsReview: z.boolean(),
      testDataPrefix: z.string().min(1, { error: "qa.testDataPrefix is required" }),
      shadow: z.boolean().optional(),
      /* Pre-generation context pack: include the live-DOM capture (A/B lever; default true). */
      domPack: z.boolean().optional(),
      /*
       * Change-coverage policy (the value keystone). off = skip; signal (default) = measure +
       * record only; enforce = also try to close the gap and block publishing if it stays low.
       */
      changeCoverage: z
        .object({
          mode: z.enum(["off", "signal", "enforce"]).optional(),
          minRatio: z.number().min(0).max(1).optional(),
          /* regenerate (default) = one regeneration from the arms of the changed code no test ran; off = none. */
          branchCases: z.enum(["regenerate", "off"]).optional(),
          /* signal (default, shadow or not) = after a green diff whose change was measured, re-run the specs that reached up to three mutants of the changed code in the served script and record how many a test noticed; off = none. Never a gate. */
          bundleMutation: z.enum(["signal", "off"]).optional(),
        })
        .optional(),
      /*
       * Test-intent lock. off = the contract is not derived; signal (default) = derive it and record
       * the would-be rejections. The retired value `enforce` is still accepted and runs as `signal`: the
       * loader warns, so an app left on it keeps being watched (config-loader.ts). opacityFlagRatio flags a
       * contract whose statically unreadable clauses cross it; the flag never blocks.
       */
      intentLock: z
        .object({
          mode: z.enum(["off", "signal", "enforce"]).transform((mode) => (mode === "enforce" ? "signal" : mode)).optional(),
          opacityFlagRatio: z.number().min(0).max(1).optional(),
        })
        .optional(),
      /*
       * The code graph is part of every run's grounding; the app declares only its scope.
       * `exclude`: repo-relative globs kept out of the index (generated or vendored source the app commits).
       */
      structuralSignals: z
        .object({
          exclude: z.array(z.string().min(1)).optional(),
        })
        .strict()
        .optional(),
      /*
       * Run-intelligence report tuning. `weights` overrides the ranker's per-insight interestingness
       * weight by insight id (e.g. { "change-coverage": 1.5 }); ids left out keep their defaults.
       */
      reports: z
        .object({
          weights: z.record(z.string(), z.number().nonnegative()).optional(),
        })
        .optional(),
      /*
       * Fix-loop budget: cap the number of grounded regeneration retries (default 2, max 5).
       * Set 0 to disable the loop entirely. The progress gate may stop sooner; this is the hard cap.
       */
      fixLoop: z
        .object({
          maxRetries: z.number().int().min(0).max(5).optional(),
        })
        .optional(),

      iterationBudget: z.number().int().positive().optional(),
      /*
       * The run_spec closed loop: lets the author of each flow of a plan execute a spec it wrote against DEV while it is still
       * authoring, so that it delivers specs it has seen pass. Each flow is granted the calls its own time runs at `perCallMs`
       * (default 120s), so the run's total is the sum of its flows' grants; `maxCalls` is an optional ceiling on that total, which
       * the flows then share (absent: none). `maxDevWrites` (default 20) caps the mutating requests to DEV of the whole run, never
       * derived from the plan. On unless `enabled` is false. Needs the OpenCode runtime and an app whose login the saved session
       * covers; a run can be forced on or off for an A/B.
       */
      closedLoop: z
        .object({
          enabled: z.boolean().optional(),
          maxCalls: z.number().int().min(1).max(50).optional(),
          perCallMs: z.number().int().min(10_000).max(600_000).optional(),
          maxDevWrites: z.number().int().min(0).max(1_000).optional(),
        })
        .optional(),
      /*
       * The authenticated agent browser: lets the authoring agents (qa-author) read DEV through the session the run
       * signed in with, by tools the orchestrator serves (the session never leaves it). On unless `enabled` is false. Needs the
       * OpenCode runtime and a login the saved session covers; a run can be forced on or off for an A/B. It never writes to DEV:
       * `denyRoutes` are paths (`*` within a segment, `**` across) it never reaches, and `allowMutating` (`[POST ]/path`) names the
       * only requests that write which it lets through (a search that is a POST, a GraphQL endpoint).
       */
      agentBrowser: z
        .object({
          enabled: z.boolean().optional(),
          denyRoutes: checkedList(routePatternError).optional(),
          allowMutating: checkedList(mutatingEntryError).optional(),
        })
        .optional(),
      /*
       * How a run is coordinated: the lead plans first, and a plan of independent flows is authored by sidekicks in parallel, each
       * closing its own run_spec loop, with the lead taking over what they cannot finish. Lead + sidekicks is the only coordination;
       * this block only sets its limits. `maxParallel` flows run at once, a plan may name
       * `maxFlows`, the planning turn takes at most `planBudgetMs`, and one flow at most `flowBudgetMs` for the runtime its sidekick
       * runs on. Needs the OpenCode runtime for the sidekicks and, for an app with a login, the run_spec loop or the authenticated
       * browser: without them the work stays with the lead.
       */
      coordination: z
        .object({
          maxParallel: z.number().int().min(1).max(6).optional(),
          maxFlows: z.number().int().min(1).optional(),
          planBudgetMs: z.number().int().min(30_000).max(900_000).optional(),
          flowBudgetMs: z
            .object({
              opencode: z.number().int().min(60_000).max(3_600_000).optional(),
            })
            .optional(),
        })
        .optional(),
    }),
    /*
     * Per-app Playwright configuration. testIdAttribute overrides the default "data-testid"
     * for apps that use a different test-id convention (e.g. "data-cy" for JHipster apps).
     * Flows into PW_TEST_ID_ATTRIBUTE env, threading through capture and execute spawns.
     * No app-specific names are hardcoded in src/ — the value comes from config only.
     */
    e2e: z
      .object({
        testIdAttribute: z.string().min(1).optional(),
        /*
         * Whether the generated specs may log in themselves. `none` (default): they get the saved session and never the
         * test account. `account`: the account (the declared auth env, or DEV_TEST_USER/PASS) is also handed to the suite
         * children, for an app whose flows need a login the saved session cannot give them. Opt-in, per app: a spec
         * that holds the account can send it to any origin the app declares.
         */
        specCredentials: z.enum(["none", "account"]).optional(),
      })
      .optional(),
    /*
     * App login. Absent = public app. `form` is a Playwright setup project that
     * writes storageState; `mtls` is a software PKCS#12 presented on the TLS
     * handshake. Values stay in the env store — these fields are variable names.
     * HTTP Basic of the DEV environment stays DEV_ENV_USER/PASS and is not this block.
     */
    auth: z
      .object({
        kind: z.enum(["form", "mtls"]),
        usernameEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        certEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        certPassEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        /* Where the login page lives when it is not found by following the app's own links. Form logins only. */
        loginPath: LoginPathSchema.optional(),
      })
      .optional(),
    /*
     * Stitcher → Generation seam: the app's declared cross-service call conventions
     * (HTTP boundary or event boundary). Absent -> undefined (no cross-service graph
     * collaborator is wired). Deep validation (catalog keys, blank strings) is owned by
     * YamlBoundaryProfileAdapter, which re-reads this same YAML at resolve time — see the
     * schema block above for the shallow/deep split rationale.
     */
    boundaries: z.array(BoundarySchema).optional(),
    report: z.object({
      onFailure: z.string().min(1),
    }),
  })

  .refine((c) => c.auth?.kind !== "form" || (!!c.auth.usernameEnv && !!c.auth.passwordEnv), {
    error: "auth.kind form requires usernameEnv and passwordEnv",
    path: ["auth"],
  })
  .refine((c) => c.auth?.kind !== "mtls" || c.auth.loginPath === undefined, {
    error: "auth.loginPath is only valid for kind form",
    path: ["auth", "loginPath"],
  })
  .refine((c) => c.auth?.kind !== "mtls" || (!!c.auth.certEnv && !!c.auth.certPassEnv), {
    error: "auth.kind mtls requires certEnv and certPassEnv",
    path: ["auth"],
  })
  .refine(
    (c) => {
      const repos = [c.repo, ...(c.services ?? []).map((s) => s.repo)];
      return new Set(repos).size === repos.length;
    },
    { error: "service repos must be unique and different from the primary repo", path: ["services"] },
  );

export type ValidatedAppConfig = z.infer<typeof AppConfigSchema>;
