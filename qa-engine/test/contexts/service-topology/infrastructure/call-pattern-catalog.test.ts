// test/contexts/service-topology/infrastructure/call-pattern-catalog.test.ts
// TDD (strict): the catalog is the ONLY place a BE→BE HTTP call-pattern shape lives.
// Config supplies the optional receiver (e.g. "restTemplate"); the core never hardcodes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CallPatternCatalog,
  KNOWN_CALL_PATTERN_KINDS,
  type CallPatternExtractor,
} from "@contexts/service-topology/infrastructure/call-pattern-catalog.ts";
import type { CallPatternRef } from "@contexts/service-topology/domain/index.ts";

/** Look up a catalog entry, asserting it is registered (noUncheckedIndexedAccess narrowing). */
function getExtractor(kind: string): CallPatternExtractor {
  const extractor = CallPatternCatalog[kind];
  assert.ok(extractor, `expected '${kind}' to be registered in the catalog`);
  return extractor;
}

test("KNOWN_CALL_PATTERN_KINDS registers the three BE→BE HTTP dialects", () => {
  assert.ok(KNOWN_CALL_PATTERN_KINDS.has("rest-template-exchange"));
  assert.ok(KNOWN_CALL_PATTERN_KINDS.has("feign-client"));
  assert.ok(KNOWN_CALL_PATTERN_KINDS.has("web-client"));
  assert.equal(KNOWN_CALL_PATTERN_KINDS.has("mystery-shape"), false);
});

// ---- rest-template-exchange ----

test("rest-template-exchange: extracts path + verb from RestTemplate.exchange(\"/path\", HttpMethod.GET, ...)", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange", receiver: "restTemplate" };
  const text = `
    public class OrderGateway {
      public String listOrders() {
        return restTemplate.exchange("/api/orders", HttpMethod.GET, null, String.class).getBody();
      }
    }
  `;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
  assert.equal(sites[0]?.rawArg, '"/api/orders"');
  assert.equal(sites[0]?.enclosingMethod, "listOrders");
  assert.equal(sites[0]?.enclosingClass, "OrderGateway");
});

test("rest-template-exchange: extracts POST from .exchange(url, HttpMethod.POST, ...)", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange", receiver: "restTemplate" };
  const text = `restTemplate.exchange("/api/orders", HttpMethod.POST, entity, Order.class);`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "post");
  assert.equal(sites[0]?.rawArg, '"/api/orders"');
});

test("rest-template-exchange: also extracts getForObject / postForObject", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange", receiver: "restTemplate" };
  const text = `
    restTemplate.getForObject("/api/orders", String.class);
    restTemplate.postForObject("/api/orders", body, Order.class);
  `;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 2);
  assert.equal(sites[0]?.verb, "get");
  assert.equal(sites[0]?.rawArg, '"/api/orders"');
  assert.equal(sites[1]?.verb, "post");
  assert.equal(sites[1]?.rawArg, '"/api/orders"');
});

test("rest-template-exchange: does NOT match a different unconfigured receiver", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange", receiver: "restTemplate" };
  const text = `otherClient.exchange("/api/orders", HttpMethod.GET, null, String.class);`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 0);
});

test("rest-template-exchange: a dynamic (non-literal) path is still reported with its raw arg", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange", receiver: "restTemplate" };
  const text = `restTemplate.exchange(url, HttpMethod.GET, null, String.class);`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
  assert.equal(sites[0]?.rawArg, "url");
});

test("rest-template-exchange: missing receiver still matches a bare .exchange( call", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange" };
  const text = `ordersClient.exchange("/api/orders", HttpMethod.GET, null, String.class);`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
});

test("rest-template-exchange: escapes regex metacharacters in the receiver", () => {
  const extractor = getExtractor("rest-template-exchange");
  const ref: CallPatternRef = { kind: "rest-template-exchange", receiver: "rest$Template" };
  const text = `rest$Template.exchange("/api/orders", HttpMethod.GET, null, String.class);`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
});

// ---- feign-client ----

test("feign-client: extracts @GetMapping / @PostMapping on a @FeignClient interface", () => {
  const extractor = getExtractor("feign-client");
  const ref: CallPatternRef = { kind: "feign-client" };
  const text = `
    @FeignClient(name = "orders")
    public interface OrderClient {
      @GetMapping("/api/orders")
      List<Order> list();

      @PostMapping("/api/orders")
      Order create(@RequestBody Order order);
    }
  `;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 2);
  const verbs = sites.map((s) => s.verb).sort();
  assert.deepEqual(verbs, ["get", "post"]);
  assert.ok(sites.every((s) => s.rawArg.includes("/api/orders")));
  assert.equal(sites.find((s) => s.verb === "get")?.enclosingMethod, "list");
  assert.equal(sites.find((s) => s.verb === "post")?.enclosingMethod, "create");
  assert.equal(sites[0]?.enclosingClass, "OrderClient");
});

test("feign-client: extracts @RequestMapping(method=, path=) on a @FeignClient type", () => {
  const extractor = getExtractor("feign-client");
  const ref: CallPatternRef = { kind: "feign-client" };
  const text = `
    @FeignClient(name = "orders")
    public interface OrderClient {
      @RequestMapping(method = RequestMethod.PUT, path = "/api/orders/{id}")
      Order update(@PathVariable String id);
    }
  `;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "put");
  assert.ok(sites[0]?.rawArg.includes("/api/orders/{id}"));
  assert.equal(sites[0]?.enclosingMethod, "update");
});

test("feign-client: does NOT extract @GetMapping on a @RestController (ingress, not a client)", () => {
  const extractor = getExtractor("feign-client");
  const ref: CallPatternRef = { kind: "feign-client" };
  const text = `
    @RestController
    @RequestMapping("/api/orders")
    public class OrderController {
      @GetMapping
      public List<Order> list() { return List.of(); }
    }
  `;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 0);
});

// ---- web-client ----

test("web-client: extracts WebClient .get().uri(\"/x\") / .post().uri(\"/x\")", () => {
  const extractor = getExtractor("web-client");
  const ref: CallPatternRef = { kind: "web-client", receiver: "webClient" };
  const text = `
    public class OrderGateway {
      public Mono<String> list() {
        return webClient.get().uri("/api/orders").retrieve().bodyToMono(String.class);
      }
      public Mono<Order> create(Order body) {
        return webClient.post().uri("/api/orders").bodyValue(body).retrieve().bodyToMono(Order.class);
      }
    }
  `;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 2);
  assert.equal(sites[0]?.verb, "get");
  assert.equal(sites[0]?.rawArg, '"/api/orders"');
  assert.equal(sites[1]?.verb, "post");
  assert.equal(sites[1]?.rawArg, '"/api/orders"');
});

test("web-client: does NOT match a different unconfigured receiver", () => {
  const extractor = getExtractor("web-client");
  const ref: CallPatternRef = { kind: "web-client", receiver: "webClient" };
  const text = `other.get().uri("/api/orders");`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 0);
});

test("web-client: missing receiver still matches a bare .get().uri( chain", () => {
  const extractor = getExtractor("web-client");
  const ref: CallPatternRef = { kind: "web-client" };
  const text = `ordersWebClient.get().uri("/api/orders");`;
  const sites = extractor(text, ref);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
});
