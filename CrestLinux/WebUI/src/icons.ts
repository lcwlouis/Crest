// The images tabs wear, as the Mac's FaviconAssets keeps them: a tab adopts
// the image its page's engine holds when the core says so
// (TabFaviconAssigned), a copy wears its source's, and the images outlive a
// relaunch, kept here in the sidebar's own storage as the Mac keeps them in
// its favicon store. The sidebar never loads a favicon's address itself:
// chrome://crest has no network access, and Chromium ends a WebUI renderer
// that asks for one.

import type { Change, Guid } from "../generated/crest_contracts.js";
import { pageRequest } from "./bridge.js";

const prefix = "crest.favicon.";

function key(tabId: Guid): string {
    return prefix + tabId;
}

function base64(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
}

export class TabIcons {
    private readonly onChange: () => void;

    constructor(onChange: () => void) {
        this.onChange = onChange;
    }

    /** The image `tabId` wears, as a data URL, or null for none. */
    imageOf(tabId: Guid): string | null {
        return localStorage.getItem(key(tabId));
    }

    apply(changes: readonly Change[]): void {
        for (const change of changes) {
            switch (change.kind) {
                case "TabFaviconAssigned": {
                    const { tabId, adopts, pageId } = change.value;
                    if (!adopts) {
                        this.set(tabId, null);
                    } else if (pageId) {
                        void pageRequest("PageIcon", { pageId })
                            .then(({ image }) => {
                                if (image) this.set(tabId, `data:image/png;base64,${base64(image)}`);
                            })
                            .catch((error: unknown) => console.error(error));
                    }
                    break;
                }
                case "TabCopied":
                    this.set(change.value.copyTabId, this.imageOf(change.value.sourceTabId));
                    break;
                case "TabsChanged":
                    for (const tabId of change.value.removed) localStorage.removeItem(key(tabId));
                    break;
                default:
                    break;
            }
        }
    }

    private set(tabId: Guid, image: string | null): void {
        if (this.imageOf(tabId) === image) return;
        if (image) localStorage.setItem(key(tabId), image);
        else localStorage.removeItem(key(tabId));
        this.onChange();
    }
}
