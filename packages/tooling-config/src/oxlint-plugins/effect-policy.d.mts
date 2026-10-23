export interface GeneratedRouteIdentityNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  range?: [number, number];
  parent?: GeneratedRouteIdentityNode;
}

export interface GeneratedRouteIdentitySource {
  readonly ast: GeneratedRouteIdentityNode;
  getText(node: GeneratedRouteIdentityNode): string;
  getAllComments(): ReadonlyArray<{
    readonly value: string;
    readonly range?: [number, number];
  }>;
}

export declare const generatedRouteBuiltinSiteIdentity: (
  node: GeneratedRouteIdentityNode,
  source: GeneratedRouteIdentitySource,
) => string;

declare const effectPolicy: unknown;
export default effectPolicy;
