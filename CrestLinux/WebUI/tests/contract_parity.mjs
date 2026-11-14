// Checks the generated TypeScript contracts against the core's own codec.
//
// The core's tests write what its codec makes of every contract value to
// contract-fixtures.json (ContractCodecTests.TypeScript.cs). This reads each
// fixture with the generated decoder, checks what the bytes alone do not say,
// writes the value back with the generated encoder and requires the same bytes.
//
//   cd CrestCore && dotnet test tests/CrestCore.Tests --filter FullyQualifiedName~ContractCodecTests
//   node CrestLinux/WebUI/tests/contract_parity.mjs [path/to/contract-fixtures.json]
//
// Node runs the TypeScript file as it is, which needs Node 22.18 or later.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as contracts from "../generated/crest_contracts.ts";

const fixturesFile = "contract-fixtures.json";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The newest fixtures the core's tests wrote beside themselves. */
function newestFixtures() {
    const output = join(repositoryRoot, "CrestCore/tests/CrestCore.Tests/bin");
    let found;
    try {
        found = readdirSync(output, { recursive: true })
            .filter((entry) => entry.endsWith(fixturesFile))
            .map((entry) => join(output, entry))
            .sort((first, second) => statSync(second).mtimeMs - statSync(first).mtimeMs)[0];
    } catch {
        found = undefined;
    }
    if (found === undefined) throw new Error(`No ${fixturesFile} under ${output}. Run the core's ContractCodecTests first.`);
    return found;
}

const toHex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

const failures = [];
function check(condition, message) {
    if (!condition) failures.push(message);
}

const path = process.argv[2] ?? newestFixtures();
const fixtures = JSON.parse(readFileSync(path, "utf8"));

check(toHex(contracts.fingerprint) === fixtures.fingerprint,
    "The TypeScript contracts were generated from another schema than the fixtures. Regenerate the contracts and rerun the core's tests.");

// The primitives, each read with the reader's own method and compared with the value the core wrote.
{
    const reader = new contracts.WireReader(fromHex(fixtures.primitives.hex));
    const writer = new contracts.WireWriter();
    const shown = {
        int64: (value) => value.toString(),
        uint64: (value) => value.toString(),
        byteString: toHex,
        date: (value) => contracts.dateFromWire(value).toISOString(),
    };
    for (const { method, value } of fixtures.primitives.expected) {
        const decoded = reader[method]();
        const actual = (shown[method] ?? ((plain) => plain))(decoded);
        check(actual === value, `primitive ${method}: read ${String(actual)}, the core wrote ${String(value)}`);
        writer[method](decoded);
    }
    reader.finish();
    check(toHex(writer.bytes()) === fixtures.primitives.hex, "primitives: the writer's bytes differ from the core's");
}

// Every contract value: decode, check, encode, compare.
for (const [index, fixture] of fixtures.values.entries()) {
    const name = `${fixture.codec}${fixture.kind ? `/${fixture.kind}` : ""} (#${index})`;
    const decode = contracts[`decode${fixture.codec}`];
    const encode = contracts[`encode${fixture.codec}`];
    if (typeof decode !== "function" || typeof encode !== "function") {
        failures.push(`${name}: the TypeScript contracts have no codec for it`);
        continue;
    }
    try {
        const reader = new contracts.WireReader(fromHex(fixture.hex));
        const decoded = decode(reader);
        reader.finish();
        if (fixture.kind !== undefined) check(decoded.kind === fixture.kind, `${name}: decoded as ${decoded.kind}`);
        if (fixture.expected !== undefined) check(decoded === fixture.expected, `${name}: decoded as ${String(decoded)}, not ${fixture.expected}`);
        const writer = new contracts.WireWriter();
        encode(writer, decoded);
        check(toHex(writer.bytes()) === fixture.hex, `${name}: the encoder's bytes differ from the core's`);
    } catch (error) {
        failures.push(`${name}: ${error}`);
    }
}

for (const failure of failures.slice(0, 40)) console.error(`error: ${failure}`);
if (failures.length > 0) {
    console.error(`${failures.length} of ${fixtures.values.length + 1} fixtures failed (${path}).`);
    process.exit(1);
}
console.log(`The TypeScript codec matches the core's on ${fixtures.values.length} values and the primitives (${path}).`);
