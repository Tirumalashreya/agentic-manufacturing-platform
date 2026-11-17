import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        child_process: false,
        perf_hooks: false,
        dns: false,
        os: false,
        path: false,
        stream: false,
        util: false,
        events: false,
        buffer: false,
        string_decoder: false,
      };
    }
    return config;
  },
};

export default nextConfig;
