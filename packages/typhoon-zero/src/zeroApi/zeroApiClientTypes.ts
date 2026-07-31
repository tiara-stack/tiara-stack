export type OptionalArgs<Args> = [Args] extends [undefined]
  ? readonly []
  : undefined extends Args
    ? readonly [] | readonly [args: Args]
    : readonly [args: Args];
