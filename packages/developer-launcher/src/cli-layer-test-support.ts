import * as Context from "effect/Context";

/** Internal deterministic seam for exercising typed CLI layer-acquisition failures. */
export class CliLayerAcquisitionFailureForTesting extends Context.Service<
  CliLayerAcquisitionFailureForTesting,
  {
    readonly error: unknown;
    readonly onBuild: () => void;
    readonly onRelease: () => void;
  }
>()("developer-launcher/CliLayerAcquisitionFailureForTesting") {}
