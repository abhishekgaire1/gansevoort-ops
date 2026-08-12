import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Raises the transport-level ceiling above our 20MB application-level
      // invoice-upload limit (app/actions/aiInvoiceExtraction.ts) -- Next's
      // default 1MB body limit would otherwise reject a real invoice photo
      // before the Server Action ever runs. This is not our file-size
      // validation; it only ensures a request under our real limit isn't
      // rejected in transport before we get to check it ourselves.
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
