/* The coverage decoder's executor with no thread: the job a worker runs, run on the calling stack. For the cases that are about what the reader does with the files and the answers (confinement, whole-or-nothing, the signal built on them) and not about where the decoding runs, which would otherwise start a worker for each read. The cases about the worker use the real one. */
import { openDecoder, type DecodeContext } from "@contexts/objective-signal/infrastructure/coverage-decode.ts";
import type { OffLoopExecutor } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

export const inThreadDecoder: OffLoopExecutor = {
  run: async (inputs, _signal, context) => {
    const decode = openDecoder(context as DecodeContext);
    return {
      kind: "done",
      outputs: inputs.map((input) => {
        try {
          return decode(Buffer.from(input));
        } catch {
          return null;
        }
      }),
    };
  },
};
