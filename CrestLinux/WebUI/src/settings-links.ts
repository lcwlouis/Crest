// Settings' Links page (BrowserLinkSettingsContent): where links from other
// apps open, and the routes that send matching links to a Space
// (BrowserLinkRoutingSection, BrowserLinkRouteCard). The core keeps the link
// preferences in its device store and applies every rule.
//
// Left out on Linux: the Quick Window section and the Quick Window
// destination, which Linux does not draw yet, and Peek, which comes with it.

import { ExternalLinkDestination, LinkRouteMatch } from "../generated/crest_contracts.js";
import type { Guid, LinkRoute } from "../generated/crest_contracts.js";
import { Menu } from "./menu.js";
import { SpaceGroups } from "./space-groups.js";
import type { SettingsContext } from "./settings.js";
import { button, element, glyphButton, group, picker, row, textField, toggle, wideRow } from "./settings-form.js";
import type { Choice } from "./settings-form.js";

export function linksPage(context: SettingsContext): (HTMLElement | null)[] {
    const links = context.preferences.links;
    const workspace = context.workspace();
    if (!links || !workspace) return [];
    const spaces: Choice<Guid>[] = new SpaceGroups(workspace).available.map((space) => ({ value: space.state.id, title: space.state.settings.name }));
    const destinations = ExternalLinkDestination.all.filter(
        (destination) => !ExternalLinkDestination.facts[destination].opensQuickWindow || destination === links.destination,
    );
    const asksForSpace = ExternalLinkDestination.facts[links.destination].asksForSpace;
    const choose = (destination: ExternalLinkDestination, spaceId: Guid | null): void =>
        void context.send({ kind: "ChooseExternalLinkDestination", value: { destination, spaceId } });
    const routes = links.routes;
    return [
        group("Links from other apps", [
            row(
                "Open in",
                picker(
                    destinations.map((destination) => ({ value: destination, title: ExternalLinkDestination.facts[destination].title.text })),
                    links.destination,
                    (destination) => choose(destination, null),
                ),
            ),
            asksForSpace
                ? row("Space", picker(spaces, links.destinationSpaceId ?? spaces[0]?.value ?? null, (spaceId) => choose(links.destination, spaceId)))
                : null,
        ]),
        group(
            "Routing",
            [
                ...(routes.length === 0 ? [wideRow(element("span", "settings-row-detail", "No routes yet."))] : []),
                ...routes.map((route, index) => routeCard(context, route, index, routes.length, spaces)),
                wideRow(
                    button("New Route", () => {
                        const destinationSpaceId = spaces[0]?.value;
                        if (destinationSpaceId) void context.send({ kind: "AddLinkRoute", value: { routeId: crypto.randomUUID(), destinationSpaceId } });
                    }),
                ),
            ],
            { footer: "Routes apply to links from other apps. The first matching route wins." },
        ),
    ];
}

/** One route: when a link's URL matches, which Space it opens in (BrowserLinkRouteCard). */
function routeCard(context: SettingsContext, route: LinkRoute, index: number, count: number, spaces: readonly Choice<Guid>[]): HTMLElement {
    const edit = (change: Partial<{ isEnabled: boolean; match: LinkRouteMatch; pattern: string; destinationSpaceId: Guid }>): void =>
        void context.send({
            kind: "EditLinkRoute",
            value: {
                routeId: route.id,
                isEnabled: change.isEnabled ?? null,
                match: change.match ?? null,
                pattern: change.pattern ?? null,
                destinationSpaceId: change.destinationSpaceId ?? null,
            },
        });
    const card = element("div", "settings-route");
    const top = element("div", "settings-route-line");
    const match = picker(
        LinkRouteMatch.all.map((value) => ({ value, title: LinkRouteMatch.facts[value].title.text })),
        route.match,
        (value) => edit({ match: value }),
    );
    match.setAttribute("aria-label", "Match");
    const enabled = toggle(route.isEnabled, (isEnabled) => edit({ isEnabled }));
    enabled.setAttribute("aria-label", "Enabled");
    const actions = glyphButton("ellipsis", "Route actions", (anchor) =>
        Menu.open(
            [
                {
                    title: "Move Up",
                    icon: { kind: "symbol", name: "arrow.up" },
                    disabled: index === 0,
                    action: () => void context.send({ kind: "MoveLinkRoute", value: { routeId: route.id, offset: -1 } }),
                },
                {
                    title: "Move Down",
                    icon: { kind: "symbol", name: "arrow.down" },
                    disabled: index === count - 1,
                    action: () => void context.send({ kind: "MoveLinkRoute", value: { routeId: route.id, offset: 1 } }),
                },
                "separator",
                {
                    title: "Delete Route",
                    icon: { kind: "symbol", name: "trash" },
                    destructive: true,
                    action: () => void context.send({ kind: "RemoveLinkRoute", value: { routeId: route.id } }),
                },
            ],
            { anchor: anchor.getBoundingClientRect() },
        ),
    );
    top.append(element("span", "settings-route-when", "When URL"), match, element("span", "settings-spacer"), enabled, actions);
    const pattern = textField(route.pattern, "example.com", (value) => edit({ pattern: value }));
    pattern.setAttribute("aria-label", "URL or text");
    const destination = picker(spaces, route.destinationSpaceId, (destinationSpaceId) => edit({ destinationSpaceId }));
    destination.setAttribute("aria-label", "Destination");
    const fields = element("div", "settings-route-fields");
    const labelled = (label: string, control: HTMLElement): HTMLElement => {
        const node = element("label", "settings-route-field");
        node.append(element("span", "settings-row-detail", label), control);
        return node;
    };
    fields.append(labelled("URL or text", pattern), labelled("Open in Space", destination));
    card.append(top, fields);
    return card;
}
