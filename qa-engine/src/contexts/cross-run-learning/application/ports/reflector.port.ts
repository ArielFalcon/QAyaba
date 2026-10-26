import type { ReflectionInput } from "../../domain/learning-repository.ts";

export interface ReflectorPort {
  reflect(input: ReflectionInput): Promise<void>;
}
