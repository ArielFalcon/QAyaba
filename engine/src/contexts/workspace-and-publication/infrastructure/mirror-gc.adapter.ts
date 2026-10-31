import type { PathMirrorGcPort } from "../application/ports/mirror-gc.port.ts";

type GcFn = (mirrorDir: string) => Promise<void>;

export class MirrorGcAdapter implements PathMirrorGcPort {
  constructor(private readonly gc: GcFn) {}

  async prune(mirrorDir: string): Promise<void> {
    await this.gc(mirrorDir);
  }
}
