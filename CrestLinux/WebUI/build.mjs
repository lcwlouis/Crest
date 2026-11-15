// Builds Crest's Linux WebUI into the directory chrome://crest serves.
//
//   node CrestLinux/WebUI/build.mjs <output directory>
//
// Node erases the TypeScript's types itself (Node 22.13 or later), so the
// build needs no packages: the sources use only erasable syntax, and their
// imports already name the .js files they become. `tsc -p CrestLinux/WebUI`
// type-checks them.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output) {
    console.error("Usage: node build.mjs <output directory>");
    process.exit(2);
}
const destination = resolve(output);

for (const folder of ["src", "generated"]) {
    mkdirSync(join(destination, folder), { recursive: true });
    for (const name of readdirSync(join(here, folder))) {
        const source = join(here, folder, name);
        if (name.endsWith(".ts")) {
            const javascript = stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" });
            writeFileSync(join(destination, folder, name.replace(/\.ts$/, ".js")), javascript);
        } else if (folder === "src") {
            // The page and its styles sit at the top of the served directory.
            copyFileSync(source, join(destination, name));
        }
    }
}
// The heraldic charges a Space's crest wears, the Mac's own artwork from its
// asset catalog, each served under the asset's name, and who drew them.
const resources = join(here, "..", "..", "CrestShared", "Resources");
const heraldry = join(resources, "CrestHeraldry.xcassets");
mkdirSync(join(destination, "heraldry"), { recursive: true });
for (const name of readdirSync(heraldry)) {
    if (!name.endsWith(".imageset")) continue;
    copyFileSync(join(heraldry, name, "charge.svg"), join(destination, "heraldry", name.replace(/\.imageset$/, ".svg")));
}
copyFileSync(join(resources, "HeraldicArtworkCredits.txt"), join(destination, "heraldry", "credits.txt"));
console.log(`Crest's WebUI is in ${destination}`);
