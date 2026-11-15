// The origin a site permission belongs to, as the Mac's SiteOrigin(url:)
// reads it from an address, and the name a person reads for it. The core
// normalizes every origin it is given, so these only spell what it keeps.

import { WebScheme } from "../generated/crest_contracts.js";
import type { SiteOrigin } from "../generated/crest_contracts.js";

/** The scheme's default port, or none for a scheme that is not a web one. */
function defaultPort(scheme: string): number | null {
    const member = WebScheme.all.find((candidate) => WebScheme.facts[candidate].name === scheme);
    return member ? WebScheme.facts[member].defaultPort : null;
}

/** The origin of `address`, or null for one with no scheme and host. */
export function siteOriginOf(address: string | null | undefined): SiteOrigin | null {
    if (!address) return null;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    const host = url.hostname.toLowerCase();
    if (!scheme || !host) return null;
    const port = url.port ? Number(url.port) : (defaultPort(scheme) ?? 0);
    return { scheme, host, port };
}

/** The origin as a person reads it: the port only when it is not the scheme's default. */
export function siteName(origin: SiteOrigin): string {
    return defaultPort(origin.scheme) === origin.port
        ? `${origin.scheme}://${origin.host}`
        : `${origin.scheme}://${origin.host}:${origin.port}`;
}

/** Whether `a` and `b` name one origin. */
export function sameSite(a: SiteOrigin | null, b: SiteOrigin | null): boolean {
    return a !== null && b !== null && a.scheme === b.scheme && a.host === b.host && a.port === b.port;
}
