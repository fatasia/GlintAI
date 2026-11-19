// Packaged as an inert capability module. It is intentionally not mounted by the
// desktop service while trusted host delivery and same-user isolation are absent.
export { createDesktopSessionRegistry } from "./desktop-session-capability.mjs";
export { createPortableChapterHandler } from "./portable-chapter-route.mjs";
export { openSecureAssets } from "./secure-assets-bridge.mjs";
