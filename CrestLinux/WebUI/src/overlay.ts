// The window raises the WebUI over the page's view while a floating surface
// is open, such as the command bar or a menu, and lowers it once the last one
// closes. Each surface holds the overlay while it shows, so one closing never
// lowers it under another.

import { setOverlay } from "./bridge.js";

let holders = 0;

/** Raises the WebUI over the page until the returned release is called. */
export function holdOverlay(): () => void {
    if (holders++ === 0) {
        document.body.classList.add("overlay");
        setOverlay(true);
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--holders > 0) return;
        setOverlay(false);
        document.body.classList.remove("overlay");
    };
}
