import type * as ZeroApi from "./zeroApi";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import type * as ZeroApiGroup from "./zeroApiGroup";

export function collectVisibleByGroup<Value>(
  api: ZeroApi.Any,
  visibilities: readonly ZeroApiEndpoint.Visibility[] | undefined,
  build: (group: ZeroApiGroup.Any, endpoint: ZeroApiEndpoint.Any) => Value,
): Record<string, Record<string, Value>>;
export function collectVisibleByGroup<Endpoint extends ZeroApiEndpoint.Any, Value>(
  api: ZeroApi.Any,
  visibilities: readonly ZeroApiEndpoint.Visibility[] | undefined,
  build: (group: ZeroApiGroup.Any, endpoint: Endpoint) => Value,
  include: (endpoint: ZeroApiEndpoint.Any) => endpoint is Endpoint,
): Record<string, Record<string, Value>>;
export function collectVisibleByGroup(
  api: ZeroApi.Any,
  visibilities: readonly ZeroApiEndpoint.Visibility[] | undefined,
  build: (group: ZeroApiGroup.Any, endpoint: ZeroApiEndpoint.Any) => unknown,
  include: (endpoint: ZeroApiEndpoint.Any) => boolean = () => true,
) {
  const groups: Record<string, Record<string, unknown>> = {};
  for (const group of Object.values(api.groups)) {
    const endpoints: Record<string, unknown> = {};
    for (const endpoint of Object.values(group.endpoints)) {
      if (include(endpoint) && ZeroApiEndpoint.isVisible(endpoint, visibilities)) {
        endpoints[endpoint.name] = build(group, endpoint);
      }
    }
    if (Object.keys(endpoints).length > 0) {
      groups[group.identifier] = endpoints;
    }
  }
  return groups;
}
