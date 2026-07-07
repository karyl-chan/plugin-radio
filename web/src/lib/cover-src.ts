/**
 * Resolve a stored cover URL for a browser `<img>`.
 *
 * Our own uploaded covers are stored host-independent as root-relative
 * `/cover/<file>` paths (see the server upload route). Under the bot proxy the
 * SPA is served from `<origin>/plugin/<key>/…`, so a bare `/cover/…` would hit
 * the wrong origin root — prefix it with the injected plugin mount path so it
 * resolves under the proxy on any host. Absolute `http(s)` URLs (YouTube
 * thumbnails, pasted image links) and blob/data previews pass through untouched.
 */
export function coverSrc(url?: string): string | undefined {
  if (!url) return undefined;
  // Root-relative served path (not a protocol-relative `//host` URL).
  if (url.startsWith("/") && !url.startsWith("//")) {
    return (window.__PLUGIN_BASE__ ?? "") + url;
  }
  return url;
}
