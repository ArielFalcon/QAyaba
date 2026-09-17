import type { MirrorGcPort } from "../application/ports/index.ts";

type GcFn = (mirrorDir: string) => Promise<void>;

export class MirrorGcAdapter implements MirrorGcPort {
  constructor(private readonly gc: GcFn) {}

  async prune(mirrorDir: string): Promise<void> {
    await this.gc(mirrorDir);
  }
}
