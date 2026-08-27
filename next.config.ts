import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    // The proxy layer (proxy.ts) has its OWN body cap (10 MB default),
    // separate from serverActions.bodySizeLimit below. A learner attaching
    // two large XMLs (hit live 2026-08-27: the 5.6 MB Day Book twice =
    // 11.2 MB) got the body truncated mid-stream, crashing the Server
    // Action with "Unexpected end of form". Keep this in lockstep with
    // serverActions.bodySizeLimit.
    proxyClientMaxBodySize: '25mb',
    serverActions: {
      // A real month's Tally Detailed Day Book export (UTF-16 XML, ~100
      // vouchers for the diagnostic pack) is several MB — Next's 1 MB
      // default rejected genuine submissions with a 413 (hit live
      // 2026-08-20). submitFiles carries both XML files in one FormData
      // body, so the limit covers Day Book + Trial Balance together.
      bodySizeLimit: '25mb',
    },
  },
};

export default nextConfig;
