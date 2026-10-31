/* Type-level pins for the classes and literals that forward a port. A decorator written by hand silently drops a method its port gains later; pinning it makes that a compile error instead. Types only: nothing here exists at run time. */

/** Compiles only when its argument is `never`: a gap in a parity check becomes a type error naming the gap. */
export type AssertNever<T extends never> = T;

/** The keys of `Port` that `Decorator` does not carry. Pin a class with `type _Forwards = AssertNever<MissingForwards<Port, Class>>`; pin a literal with `satisfies ForwardsAll<Port>`. */
export type MissingForwards<Port, Decorator> = Exclude<keyof Port, keyof Decorator>;

/** What a literal that forwards `Port` must satisfy: `Port` itself, so its members keep their contextual types, and every member `Required<Port>` names, optional ones included. It is `satisfies Record<keyof Required<Port>, unknown>` with the types of `Port` kept. */
export type ForwardsAll<Port> = Port & Record<keyof Required<Port>, unknown>;
