import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Fleet — control panel",
    short_name: "Fleet",
    description: "Manage every machine in your fleet: live metrics, shells, updates and power.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: "#16161e",
    theme_color: "#16161e",
    categories: ["utilities", "developer"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Terminal", short_name: "Terminal", url: "/?terminal=1", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Activity", short_name: "Activity", url: "/activity", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
