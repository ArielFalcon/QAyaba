import type { ServiceBoundaryResolverPort } from "../application/ports/index.ts";
import type { BoundaryProfile, HttpBoundaryProfile, EventBoundaryProfile, HttpBackendBoundaryProfile } from "../domain/index.ts";
import { CompositeServiceBoundaryResolver } from "./composite-resolver.adapter.ts";
import { OpenApiHttpResolver } from "./openapi-http-resolver.adapter.ts";
import { EventResolver } from "./event-resolver.adapter.ts";
import { HttpBackendResolver } from "./http-backend-resolver.adapter.ts";

type ResolverBuilder = (profile: BoundaryProfile) => ServiceBoundaryResolverPort;

const RESOLVER_REGISTRY: Record<BoundaryProfile["transport"], ResolverBuilder> = {
  http: (profile) => new OpenApiHttpResolver(profile as HttpBoundaryProfile),
  event: (profile) => new EventResolver(profile as EventBoundaryProfile),
  "http-backend": (profile) => new HttpBackendResolver(profile as HttpBackendBoundaryProfile),
};

/** Compose a ServiceBoundaryResolverPort from an app's declared boundary profiles. Never throws: an unrecognized transport is skipped (loud warn), and an empty/all-unrecognized input yields a CompositeServiceBoundaryResolver with zero resolvers, which already fail-opens to an empty ResolveLinksResult. */
export function buildServiceBoundaryResolver(profiles: readonly BoundaryProfile[]): ServiceBoundaryResolverPort {
  const resolvers: ServiceBoundaryResolverPort[] = [];
  for (const profile of profiles) {
    const build = RESOLVER_REGISTRY[profile.transport];
    if (!build) {
      console.warn(
        `[buildServiceBoundaryResolver] no resolver registered for transport "${profile.transport}" — skipping profile`,
      );
      continue;
    }
    resolvers.push(build(profile));
  }
  return new CompositeServiceBoundaryResolver(resolvers);
}
