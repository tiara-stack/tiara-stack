/** Development gateway hostnames use a `dev.` DNS label and contain no production labels. */
export const isApprovedDevelopmentGatewayDomain = (domain: string) =>
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*dev\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
    domain,
  ) &&
  domain.length < 190 &&
  !/(^|[.-])(prod|production|live)([.-]|$)/.test(domain);
