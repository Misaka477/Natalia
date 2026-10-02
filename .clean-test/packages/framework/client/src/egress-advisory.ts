/** Shared disclosure for outbound traffic outside fetch-style tools. */
export const EGRESS_ADVISORY =
  "egress: the application-layer host allowlist only covers fetch-style tools; outbound traffic from run_shell and native terminal input is not constrained here, so configure egress in your firewall or container network";
