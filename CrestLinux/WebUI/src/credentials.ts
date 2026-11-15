// Crest's saved passwords on Linux, as the Mac keeps them: one Secret Service
// "service" per Space (the Mac's CredentialKeychainNamespace), each item a
// password whose account is its id and whose metadata is its descriptor
// (CredentialKeychainCodec), read and written by the rules of the Mac's
// KeychainCredentialVault, and kept for a Space's group by the flows of its
// BrowserStore+Credentials. The browser process only stores and reads items
// (crest_credentials_linux); the core decides from descriptors alone
// (CredentialSaveMatch, CredentialSave, CredentialsFillingPage, ...), and
// never sees a password except the ones an import hands it to compare.

import type {
    CredentialImportPlan,
    CredentialOrigin,
    CredentialRecord,
    ExistingCredential,
    Guid,
    ImportedCredential,
} from "../generated/crest_contracts.js";
import { CredentialImportEffect, WebScheme } from "../generated/crest_contracts.js";
import { credentialItems, deleteCredential, query, upsertCredential } from "./bridge.js";
import type { CredentialItem } from "./bridge.js";
import type { Space, Workspace } from "./model.js";
import { SpaceGroups } from "./space-groups.js";

// MARK: - Types

/** What a saved password is for: a web form, or a site's HTTP sign-in (BrowserCredentialScope). */
export type CredentialScope =
    | { readonly kind: "webForm" }
    | { readonly kind: "httpBasic"; readonly realm: string | null }
    | { readonly kind: "httpDigest"; readonly realm: string | null };

/** A saved password's description, without the password (CredentialDescriptor). Dates are seconds since 1970. */
export interface CredentialDescriptor {
    readonly id: Guid;
    readonly spaceID: Guid;
    readonly origin: CredentialOrigin;
    readonly scope: CredentialScope;
    readonly username: string;
    readonly displayName: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly lastUsedAt: number | null;
    readonly isSynchronizable: boolean;
}

/** A saved password and its description (BrowserCredential). */
export interface BrowserCredential {
    readonly descriptor: CredentialDescriptor;
    readonly password: string;
}

/** A Space's readable passwords, and how many more no longer read back (CredentialInventory). */
export interface CredentialInventory {
    readonly descriptors: CredentialDescriptor[];
    readonly unreadableCount: number;
}

/** A login a page submitted, which Crest may offer to save (BrowserCredentialSaveCandidate). */
export interface CredentialSaveCandidate {
    readonly origin: CredentialOrigin;
    readonly topLevelOrigin: CredentialOrigin;
    readonly username: string;
    readonly password: string;
    /** Seconds since 1970. */
    readonly submittedAt: number;
}

/** What saving a candidate does (BrowserCredentialSavePlan). */
export type CredentialSavePlan =
    | { readonly kind: "Create" }
    | { readonly kind: "Update"; readonly existing: CredentialDescriptor }
    | { readonly kind: "AlreadyStored"; readonly existing: CredentialDescriptor };

/** Why a password could not be read or kept (CredentialVaultError). */
export class CredentialVaultError extends Error {
    static readonly missingSpace = new CredentialVaultError("The Space is gone.");
    static readonly invalidOrigin = new CredentialVaultError("The address can't keep passwords.");
    static readonly insecureOrigin = new CredentialVaultError("Passwords are kept only for secure pages.");
    static readonly credentialManagerDisabled = new CredentialVaultError("Crest Passwords is off in this Space.");
    static readonly staleSaveCandidate = new CredentialVaultError("The sign-in is too old to save.");
    static readonly saveDecisionUnavailable = new CredentialVaultError("Crest couldn't decide how to save the password.");
    static readonly malformedStoredCredential = new CredentialVaultError("A saved password no longer reads back.");
    static readonly atomicReplacementRestoreFailed = new CredentialVaultError("Crest couldn't restore the Space's passwords.");

    private constructor(message: string) {
        super(message);
        this.name = "CredentialVaultError";
    }
}

/** What one import of another browser's passwords did (BrowserPasswordImportResult). */
export interface PasswordImportResult {
    readonly importedCount: number;
    readonly skippedCount: number;
    readonly unsavedCount: number;
}

/** A password read from another browser to import (BrowserImportedPassword). */
export interface ImportedPassword {
    readonly sourceProfileName: string;
    readonly origin: CredentialOrigin;
    readonly username: string;
    readonly password: string;
}

// MARK: - Origins

/**
 * The canonical origin of `address` (CredentialOrigin+Platform): a lowercased
 * HTTP(S) scheme and host, without an IPv6 address's brackets, and an explicit
 * port; null for any other address.
 */
export function credentialOrigin(address: string): CredentialOrigin | null {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    const scheme = WebScheme.all.map((member) => WebScheme.facts[member]).find((facts) => `${facts.name}:` === url.protocol);
    if (!scheme || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (!host || /[%@/?#\\\s]/.test(host)) return null;
    const port = url.port ? Number(url.port) : scheme.defaultPort;
    if (!(port >= 1 && port <= 65_535)) return null;
    return { scheme: scheme.name, host, port };
}

/** Whether `origin` is secure enough to keep passwords for. */
export function isSecureOrigin(origin: CredentialOrigin): boolean {
    return WebScheme.all.some((member) => WebScheme.facts[member].name === origin.scheme && WebScheme.facts[member].isSecure);
}

/** How the origin reads, as the Mac's CredentialOrigin.description. */
export function originDescription(origin: CredentialOrigin): string {
    const host = origin.host.includes(":") ? `[${origin.host}]` : origin.host;
    const scheme = WebScheme.all.map((member) => WebScheme.facts[member]).find((facts) => facts.name === origin.scheme);
    return scheme?.defaultPort === origin.port ? `${origin.scheme}://${host}` : `${origin.scheme}://${host}:${origin.port}`;
}

export function sameOrigin(left: CredentialOrigin, right: CredentialOrigin): boolean {
    return left.scheme === right.scheme && left.host === right.host && left.port === right.port;
}

// MARK: - Codec

/** The descriptor `metadata` holds, or null when it is not one Crest wrote for `spaceID` and `account`. */
function decodeDescriptor(item: CredentialItem, spaceID: Guid): CredentialDescriptor | null {
    let value: unknown;
    try {
        value = JSON.parse(item.metadata);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const fields = value as Record<string, unknown>;
    const origin = fields["origin"] as Record<string, unknown> | undefined;
    const isString = (entry: unknown): entry is string => typeof entry === "string";
    const isNumber = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry);
    if (
        !isString(fields["id"]) ||
        !isString(fields["spaceID"]) ||
        !isString(fields["username"]) ||
        !isNumber(fields["createdAt"]) ||
        !isNumber(fields["updatedAt"]) ||
        typeof fields["isSynchronizable"] !== "boolean" ||
        typeof origin !== "object" ||
        origin === null ||
        !isString(origin["scheme"]) ||
        !isString(origin["host"]) ||
        !isNumber(origin["port"])
    ) {
        return null;
    }
    // Stored origins keep their canonical spelling; any other reads as unreadable.
    const host = origin["host"].includes(":") ? `[${origin["host"]}]` : origin["host"];
    const canonical = credentialOrigin(`${origin["scheme"]}://${host}:${origin["port"]}`);
    if (!canonical || canonical.scheme !== origin["scheme"] || canonical.host !== origin["host"] || canonical.port !== origin["port"]) {
        return null;
    }
    const scope = decodeScope(fields["scope"]);
    const displayName = fields["displayName"];
    const lastUsedAt = fields["lastUsedAt"];
    const descriptor: CredentialDescriptor = {
        id: fields["id"].toLowerCase(),
        spaceID: fields["spaceID"].toLowerCase(),
        origin: canonical,
        scope: scope ?? { kind: "webForm" },
        username: fields["username"],
        displayName: isString(displayName) ? displayName : null,
        createdAt: fields["createdAt"],
        updatedAt: fields["updatedAt"],
        lastUsedAt: isNumber(lastUsedAt) ? lastUsedAt : null,
        isSynchronizable: fields["isSynchronizable"],
    };
    if (scope === undefined || descriptor.spaceID !== spaceID || descriptor.id !== item.account) return null;
    if (descriptor.isSynchronizable !== item.synchronizable) return null;
    return descriptor;
}

/** The scope a descriptor names; webForm when it names none, undefined when it is not one. */
function decodeScope(value: unknown): CredentialScope | undefined {
    if (value === undefined || value === null) return { kind: "webForm" };
    if (typeof value !== "object") return undefined;
    const fields = value as Record<string, unknown>;
    if (fields["kind"] === "webForm") return { kind: "webForm" };
    if ((fields["kind"] === "httpBasic" || fields["kind"] === "httpDigest") && (fields["realm"] === null || typeof fields["realm"] === "string")) {
        return { kind: fields["kind"], realm: fields["realm"] as string | null };
    }
    return undefined;
}

/** The item that keeps `credential` in the Space `spaceID`. */
function encodeCredential(credential: BrowserCredential, spaceID: Guid): Required<CredentialItem> {
    const { descriptor } = credential;
    if (descriptor.spaceID !== spaceID) throw CredentialVaultError.malformedStoredCredential;
    const item = {
        account: descriptor.id.toLowerCase(),
        metadata: JSON.stringify({
            id: descriptor.id,
            spaceID: descriptor.spaceID,
            origin: descriptor.origin,
            scope: descriptor.scope,
            username: descriptor.username,
            displayName: descriptor.displayName ?? undefined,
            createdAt: descriptor.createdAt,
            updatedAt: descriptor.updatedAt,
            lastUsedAt: descriptor.lastUsedAt ?? undefined,
            isSynchronizable: descriptor.isSynchronizable,
        }),
        synchronizable: descriptor.isSynchronizable,
        secret: credential.password,
    };
    // Reading a Space decodes every item, so an item that would not read back
    // is refused here instead of making the whole Space unreadable.
    if (!decodeDescriptor(item, spaceID)) throw CredentialVaultError.malformedStoredCredential;
    return item;
}

function sameItem(left: CredentialItem, right: CredentialItem): boolean {
    return left.account === right.account && left.metadata === right.metadata &&
        left.synchronizable === right.synchronizable && left.secret === right.secret;
}

// MARK: - Vault

/** The Space's service, as the Mac's CredentialKeychainNamespace names it. */
export function credentialService(spaceID: Guid): string {
    return `com.pauldavis.crest.space.${spaceID.toLowerCase()}.credential`;
}

/** Usernames in order, case aside, then ids (KeychainCredentialVault.descriptorOrder). */
function descriptorOrder(left: CredentialDescriptor, right: CredentialDescriptor): number {
    const usernames = left.username.localeCompare(right.username, undefined, { sensitivity: "accent" });
    if (usernames !== 0) return usernames;
    return left.id.toUpperCase() < right.id.toUpperCase() ? -1 : left.id.toUpperCase() > right.id.toUpperCase() ? 1 : 0;
}

/**
 * Crest's saved passwords in the Secret Service, one service per Space
 * (KeychainCredentialVault). Listing a Space leaves out an item that no
 * longer reads back, so one bad item never makes the rest unreadable. Writes
 * take turns, so a write never reads or restores over another's.
 */
class CredentialVault {
    private writes: Promise<unknown> = Promise.resolve();

    // MARK: - Reading

    async descriptors(spaceID: Guid): Promise<CredentialDescriptor[]> {
        return (await this.inventory(spaceID)).descriptors;
    }

    /** One read of the Space's service answers both its passwords and how many don't read back. */
    async inventory(spaceID: Guid): Promise<CredentialInventory> {
        const items = await credentialItems(credentialService(spaceID), "", false);
        const descriptors = items
            .map((item) => decodeDescriptor(item, spaceID))
            .filter((descriptor): descriptor is CredentialDescriptor => descriptor !== null);
        return { descriptors: descriptors.sort(descriptorOrder), unreadableCount: items.length - descriptors.length };
    }

    /** The web-form passwords that fill a page at `origin`: its own, and the ones the core reads as it. */
    async descriptorsMatching(origin: CredentialOrigin, spaceID: Guid): Promise<CredentialDescriptor[]> {
        const webForms = (await this.descriptors(spaceID)).filter((descriptor) => descriptor.scope.kind === "webForm");
        return (await filling(origin, webForms)).sort(descriptorOrder);
    }

    async credential(id: Guid, spaceID: Guid): Promise<BrowserCredential | null> {
        const [item] = await credentialItems(credentialService(spaceID), id.toLowerCase(), true);
        if (!item) return null;
        const descriptor = decodeDescriptor(item, spaceID);
        if (!descriptor || descriptor.id !== id.toLowerCase() || item.secret === undefined) {
            throw CredentialVaultError.malformedStoredCredential;
        }
        return { descriptor, password: item.secret };
    }

    // MARK: - Writing

    async save(credential: BrowserCredential, spaceID: Guid): Promise<void> {
        const item = encodeCredential(credential, spaceID);
        await this.writing(() => upsertCredential(credentialService(spaceID), item));
    }

    /**
     * Makes the Space hold `credentials`: writes each that differs from what
     * it holds, then removes what they leave out, so a stop partway keeps
     * every password. A failure undoes exactly what the replacement did.
     */
    async replaceAll(credentials: readonly BrowserCredential[], spaceID: Guid): Promise<void> {
        const service = credentialService(spaceID);
        const replacements = credentials.map((credential) => encodeCredential(credential, spaceID));
        const accounts = new Set(replacements.map((item) => item.account));
        if (accounts.size !== replacements.length) throw CredentialVaultError.malformedStoredCredential;
        await this.writing(async () => {
            const originalItems = await credentialItems(service, "", true);
            const originals = new Map<string, CredentialItem>();
            for (const item of originalItems) if (!originals.has(item.account)) originals.set(item.account, item);
            const changed = replacements.filter((item) => {
                const original = originals.get(item.account);
                return !original || !sameItem(original, item);
            });
            // An item that no longer reads back is in no inventory a caller
            // can name, so a replacement keeps it.
            const leftOut = originalItems.filter((item) => !accounts.has(item.account) && decodeDescriptor(item, spaceID) !== null);
            const written: CredentialItem[] = [];
            const removed: CredentialItem[] = [];
            try {
                for (const item of changed) {
                    await upsertCredential(service, item);
                    written.push(item);
                }
                for (const item of leftOut) {
                    await deleteCredential(service, item.account);
                    removed.push(item);
                }
            } catch (error) {
                try {
                    for (const item of written.reverse()) {
                        const original = originals.get(item.account);
                        if (original && original.secret !== undefined) {
                            await upsertCredential(service, { ...original, secret: original.secret });
                        } else {
                            await deleteCredential(service, item.account);
                        }
                    }
                    for (const item of removed) {
                        if (item.secret !== undefined) await upsertCredential(service, { ...item, secret: item.secret });
                    }
                } catch {
                    throw CredentialVaultError.atomicReplacementRestoreFailed;
                }
                throw error;
            }
        });
    }

    async delete(id: Guid, spaceID: Guid): Promise<void> {
        // An empty account names every item of the service, so an id never is one.
        if (!id) return;
        await this.writing(() => deleteCredential(credentialService(spaceID), id.toLowerCase()));
    }

    async deleteUnreadable(spaceID: Guid): Promise<void> {
        const service = credentialService(spaceID);
        await this.writing(async () => {
            for (const item of await credentialItems(service, "", false)) {
                if (decodeDescriptor(item, spaceID) === null && item.account) await deleteCredential(service, item.account);
            }
        });
    }

    // MARK: - Turns

    /** Runs `write` once no other write holds the vault. */
    private writing<Result>(write: () => Promise<Result>): Promise<Result> {
        const turn = this.writes.then(write, write);
        this.writes = turn.catch(() => undefined);
        return turn;
    }
}

/** The most saved origins one fill question may carry. */
const fillBatchLimit = 1_024;
/** The most records one recency or account question may carry. */
const credentialBatchLimit = 64;

/** The descriptors among `descriptors` whose passwords fill a page at `origin`. */
async function filling(origin: CredentialOrigin, descriptors: readonly CredentialDescriptor[]): Promise<CredentialDescriptor[]> {
    const others = descriptors.filter((descriptor) => !sameOrigin(descriptor.origin, origin));
    const fills: boolean[] = [];
    try {
        for (let start = 0; start < others.length; start += fillBatchLimit) {
            const batch = others.slice(start, start + fillBatchLimit).map((descriptor) => descriptor.origin);
            fills.push(...(await query("CredentialsFillingPage", { page: origin, saved: batch })).fills);
        }
    } catch {
        // No page has such an origin, but if one did, its own passwords still fill it.
        fills.length = 0;
    }
    const fillingIds = new Set(others.filter((_, index) => fills[index] === true).map((descriptor) => descriptor.id));
    return descriptors.filter((descriptor) => sameOrigin(descriptor.origin, origin) || fillingIds.has(descriptor.id));
}

function credentialRecord(descriptor: CredentialDescriptor, includesUsername: boolean): CredentialRecord {
    return {
        id: descriptor.id,
        username: includesUsername ? descriptor.username : null,
        updatedAt: descriptor.updatedAt,
        lastUsedAt: descriptor.lastUsedAt,
    };
}

/** The core's pick among `descriptors`, asked in core-sized batches: its winner of winners is its winner of all. */
async function reduceCredentials(
    descriptors: readonly CredentialDescriptor[],
    choose: (batch: readonly CredentialDescriptor[]) => Promise<Guid | null>,
): Promise<CredentialDescriptor | null> {
    const winner = async (batch: readonly CredentialDescriptor[]): Promise<CredentialDescriptor | null> => {
        const id = await choose(batch);
        if (id === null) return null;
        const descriptor = batch.find((entry) => entry.id === id);
        if (!descriptor) throw new Error("The core chose a credential it was not asked about.");
        return descriptor;
    };
    let remaining = [...descriptors];
    while (remaining.length > credentialBatchLimit) {
        const winners: CredentialDescriptor[] = [];
        for (let start = 0; start < remaining.length; start += credentialBatchLimit) {
            const descriptor = await winner(remaining.slice(start, start + credentialBatchLimit));
            if (descriptor) winners.push(descriptor);
        }
        remaining = winners;
    }
    return winner(remaining);
}

/** The most recently used or changed of `descriptors` (MostRecentCredential). */
export function mostRecentCredential(descriptors: readonly CredentialDescriptor[]): Promise<CredentialDescriptor | null> {
    return reduceCredentials(descriptors, async (batch) =>
        (await query("MostRecentCredential", { records: batch.map((entry) => credentialRecord(entry, false)) })).credentialId);
}

/** The most recent of `descriptors` for the same account as `username` (CredentialSaveMatch). */
function credentialSaveMatch(username: string, descriptors: readonly CredentialDescriptor[]): Promise<CredentialDescriptor | null> {
    return reduceCredentials(descriptors, async (batch) =>
        (await query("CredentialSaveMatch", { username, records: batch.map((entry) => credentialRecord(entry, true)) })).credentialId);
}

// MARK: - Store

/**
 * The passwords a Space's group keeps, as the Mac's BrowserStore keeps them:
 * the primary keeps the group's new passwords, and each Sub-Space keeps the
 * ones it saved before it joined.
 */
export class CredentialStore {
    static readonly shared = new CredentialStore();

    private readonly vault = new CredentialVault();
    /** Saves under way, by Space, origin and account, so the same sign-in saves once. */
    private readonly saving = new Map<string, Promise<unknown>>();

    private constructor() {}

    // MARK: - Groups

    /** The Spaces whose vaults the group of `space` keeps, the primary first (credentialSpaceIDs). */
    vaults(workspace: Workspace, space: Space): Guid[] {
        const members = new SpaceGroups(workspace).members(space).map((member) => member.state.id);
        return members.length > 0 ? members : [space.state.id];
    }

    private space(workspace: Workspace, spaceID: Guid): Space {
        const space = workspace.spaces.get(spaceID);
        if (!space) throw CredentialVaultError.missingSpace;
        return space;
    }

    /** The vault that keeps `existing`, or the one that keeps the group's new passwords. */
    private vaultFor(workspace: Workspace, space: Space, existing: CredentialDescriptor | null): Guid {
        const vaults = this.vaults(workspace, space);
        if (!existing) return vaults[0] as Guid;
        if (!vaults.includes(existing.spaceID)) throw CredentialVaultError.malformedStoredCredential;
        return existing.spaceID;
    }

    // MARK: - Reading

    /** The passwords the Space's group keeps, with how many more no longer read back. */
    async inventory(workspace: Workspace, spaceID: Guid): Promise<CredentialInventory> {
        const space = this.space(workspace, spaceID);
        const descriptors: CredentialDescriptor[] = [];
        let unreadableCount = 0;
        for (const vault of this.vaults(workspace, space)) {
            const inventory = await this.vault.inventory(vault);
            descriptors.push(...inventory.descriptors);
            unreadableCount += inventory.unreadableCount;
        }
        return { descriptors, unreadableCount };
    }

    /** The passwords that fill a page at `origin` in the Space's group; none when the Space keeps none. */
    async suggestions(workspace: Workspace, spaceID: Guid, origin: CredentialOrigin): Promise<CredentialDescriptor[]> {
        const space = this.space(workspace, spaceID);
        if (!space.state.settings.credentialPreferences.isEnabled || !isSecureOrigin(origin)) return [];
        const descriptors: CredentialDescriptor[] = [];
        for (const vault of this.vaults(workspace, space)) descriptors.push(...(await this.vault.descriptorsMatching(origin, vault)));
        return descriptors;
    }

    /** The password `id` names among the ones the Space's group keeps. */
    async credential(workspace: Workspace, spaceID: Guid, id: Guid): Promise<BrowserCredential | null> {
        const space = this.space(workspace, spaceID);
        for (const vault of this.vaults(workspace, space)) {
            const credential = await this.vault.credential(id, vault);
            if (credential) return credential;
        }
        return null;
    }

    /** Every password the Space's own vault keeps, read in full (credentialInventory). */
    async credentialsIn(spaceID: Guid): Promise<BrowserCredential[]> {
        const credentials: BrowserCredential[] = [];
        for (const descriptor of await this.vault.descriptors(spaceID)) {
            const credential = await this.vault.credential(descriptor.id, spaceID);
            if (!credential || credential.descriptor.spaceID !== spaceID) throw CredentialVaultError.malformedStoredCredential;
            credentials.push(credential);
        }
        return credentials;
    }

    // MARK: - Saving

    /** Whether the core still takes `candidate` for the Space (validateCredentialSaveCandidate). */
    private async validate(workspace: Workspace, spaceID: Guid, candidate: CredentialSaveCandidate): Promise<void> {
        const space = this.space(workspace, spaceID);
        if (!space.state.settings.credentialPreferences.isEnabled) throw CredentialVaultError.credentialManagerDisabled;
        let validity: string;
        try {
            validity = (await query("CredentialSaveCheck", {
                origin: candidate.origin,
                topLevelOrigin: candidate.topLevelOrigin,
                submittedAt: candidate.submittedAt,
                now: Date.now() / 1000,
            })).validity;
        } catch {
            throw CredentialVaultError.saveDecisionUnavailable;
        }
        if (validity === "InsecureOrigin") throw CredentialVaultError.insecureOrigin;
        if (validity === "Stale") throw CredentialVaultError.staleSaveCandidate;
    }

    /**
     * What saving `candidate` does. The core matches the account and plans
     * from descriptors alone; the stored password is compared here and only
     * the answer is passed on.
     */
    async savePlan(workspace: Workspace, spaceID: Guid, candidate: CredentialSaveCandidate): Promise<CredentialSavePlan> {
        await this.validate(workspace, spaceID, candidate);
        const space = this.space(workspace, spaceID);
        const descriptors: CredentialDescriptor[] = [];
        for (const vault of this.vaults(workspace, space)) {
            descriptors.push(...(await this.vault.descriptorsMatching(candidate.origin, vault)));
        }
        await this.validate(workspace, spaceID, candidate);
        let descriptor: CredentialDescriptor | null;
        try {
            descriptor = await credentialSaveMatch(candidate.username, descriptors);
        } catch {
            throw CredentialVaultError.saveDecisionUnavailable;
        }
        let stored: { id: Guid; passwordMatches: boolean } | null = null;
        if (descriptor) {
            const credential = await this.vault.credential(descriptor.id, descriptor.spaceID);
            await this.validate(workspace, spaceID, candidate);
            if (credential) stored = { id: descriptor.id, passwordMatches: credential.password === candidate.password };
        }
        let plan: { kind: string; id: Guid | null };
        try {
            plan = await query("CredentialSave", { matchId: descriptor?.id ?? null, stored });
        } catch {
            throw CredentialVaultError.saveDecisionUnavailable;
        }
        if (plan.kind === "Create") return { kind: "Create" };
        if (!descriptor || plan.id !== descriptor.id) throw CredentialVaultError.saveDecisionUnavailable;
        return plan.kind === "Update" ? { kind: "Update", existing: descriptor } : { kind: "AlreadyStored", existing: descriptor };
    }

    /**
     * Saves `candidate` as its plan says, after any save of the same sign-in
     * under way (commitCredentialSave). Answers the saved descriptor, or null
     * when the Space already kept it.
     */
    commitSave(workspace: Workspace, spaceID: Guid, candidate: CredentialSaveCandidate): Promise<CredentialDescriptor | null> {
        const key = `${spaceID}|${originDescription(candidate.origin)}|${candidate.username}`;
        const preceding = this.saving.get(key) ?? Promise.resolve();
        const save = preceding.catch(() => undefined).then(async () => {
            await this.validate(workspace, spaceID, candidate);
            const plan = await this.savePlan(workspace, spaceID, candidate);
            if (plan.kind === "AlreadyStored") return null;
            return this.save(workspace, spaceID, {
                origin: candidate.origin,
                username: candidate.username,
                password: candidate.password,
                existing: plan.kind === "Update" ? plan.existing : null,
            });
        });
        this.saving.set(key, save);
        void save.finally(() => {
            if (this.saving.get(key) === save) this.saving.delete(key);
        }).catch(() => undefined);
        return save;
    }

    /** Saves a web form's password in the Space's group, in place of `existing` when it names the account. */
    async save(
        workspace: Workspace,
        spaceID: Guid,
        password: {
            readonly origin: CredentialOrigin;
            readonly username: string;
            readonly password: string;
            readonly displayName?: string | null;
            readonly existing: CredentialDescriptor | null;
        },
    ): Promise<CredentialDescriptor> {
        const space = this.space(workspace, spaceID);
        const preferences = space.state.settings.credentialPreferences;
        if (!preferences.isEnabled) throw CredentialVaultError.credentialManagerDisabled;
        if (!isSecureOrigin(password.origin)) throw CredentialVaultError.insecureOrigin;
        // A group keeps new passwords in its primary, and each one where it is.
        const vaultID = this.vaultFor(workspace, space, password.existing);
        const now = Date.now() / 1000;
        const displayName = password.displayName ? password.displayName : null;
        let descriptor: CredentialDescriptor;
        if (password.existing) {
            if (!sameOrigin(password.existing.origin, password.origin)) throw CredentialVaultError.invalidOrigin;
            descriptor = {
                ...password.existing,
                username: password.username,
                displayName: displayName ?? password.existing.displayName,
                updatedAt: now,
                isSynchronizable: preferences.syncsCrestPasswordsWithICloud,
            };
        } else {
            descriptor = {
                id: crypto.randomUUID(),
                spaceID: vaultID,
                origin: password.origin,
                scope: { kind: "webForm" },
                username: password.username,
                displayName,
                createdAt: now,
                updatedAt: now,
                lastUsedAt: null,
                isSynchronizable: preferences.syncsCrestPasswordsWithICloud,
            };
        }
        await this.vault.save({ descriptor, password: password.password }, vaultID);
        return descriptor;
    }

    /** Marks a filled password used now, so the next fill offers it first. */
    async markUsed(credential: BrowserCredential): Promise<void> {
        const descriptor = { ...credential.descriptor, lastUsedAt: Date.now() / 1000 };
        await this.vault.save({ descriptor, password: credential.password }, descriptor.spaceID);
    }

    // MARK: - Removing

    /** Deletes the password `id` names from whichever vault of the Space's group keeps it. */
    async delete(workspace: Workspace, spaceID: Guid, id: Guid): Promise<void> {
        const space = this.space(workspace, spaceID);
        for (const vault of this.vaults(workspace, space)) {
            if ((await this.vault.descriptors(vault)).some((descriptor) => descriptor.id === id)) await this.vault.delete(id, vault);
        }
    }

    async deleteUnreadable(workspace: Workspace, spaceID: Guid): Promise<void> {
        const space = this.space(workspace, spaceID);
        for (const vault of this.vaults(workspace, space)) await this.vault.deleteUnreadable(vault);
    }

    /** Makes the Space's own vault hold exactly `credentials` (replaceCredentialInventory). */
    async replaceInventory(spaceID: Guid, credentials: readonly BrowserCredential[]): Promise<void> {
        if (credentials.some((credential) => credential.descriptor.spaceID !== spaceID)) throw CredentialVaultError.malformedStoredCredential;
        await this.vault.replaceAll(credentials, spaceID);
    }

    // MARK: - Importing

    /**
     * Imports another browser's `passwords` for the review setup holds over
     * `workspace` (BrowserPasswordImportCommitter). The core says which
     * Spaces each goes to and what each account means against what a Space
     * keeps; a Space keeps its saved password for an account it already has.
     * When a Space's passwords can't be read or written, the ones it would
     * have taken count as unsaved.
     */
    async importPasswords(workspace: Workspace, passwords: readonly ImportedPassword[]): Promise<PasswordImportResult> {
        if (passwords.length === 0) return { importedCount: 0, skippedCount: 0, unsavedCount: 0 };
        let routes: readonly { readonly spaceIds: readonly Guid[] }[];
        try {
            routes = (await query("ImportPasswordDestinations", {
                workspaceId: workspace.id,
                passwords: passwords.map((password) => ({ profileName: password.sourceProfileName, host: password.origin.host })),
            })).routes;
        } catch {
            return { importedCount: 0, skippedCount: 0, unsavedCount: passwords.length };
        }
        const bySpace = new Map<Guid, ImportedCredential[]>();
        let skippedCount = 0;
        passwords.forEach((password, index) => {
            const route = routes[index];
            if (!route || route.spaceIds.length === 0) {
                skippedCount += 1;
                return;
            }
            for (const spaceID of route.spaceIds) {
                bySpace.set(spaceID, [
                    ...(bySpace.get(spaceID) ?? []),
                    { rowNumber: index + 2, displayName: password.origin.host, origin: password.origin, username: password.username, password: password.password },
                ]);
            }
        });
        let importedCount = 0;
        let unsavedCount = 0;
        for (const [spaceID, credentials] of bySpace) {
            const space = workspace.spaces.get(spaceID);
            if (!space) {
                skippedCount += credentials.length;
                continue;
            }
            let taking = credentials.length;
            try {
                const existing = await this.credentialsIn(spaceID);
                const plan = await query("PasswordImportPreview", { credentials, existing: existing.map(existingCredential) });
                const resolution = resolveImport(plan, existing, spaceID, space.state.settings.credentialPreferences.syncsCrestPasswordsWithICloud);
                skippedCount += resolution.skippedCount + resolution.rejectedCount;
                taking = resolution.acceptedCount;
                if (taking > 0) await this.replaceInventory(spaceID, resolution.credentials);
                importedCount += taking;
            } catch {
                unsavedCount += taking;
            }
        }
        return { importedCount, skippedCount, unsavedCount };
    }
}

/** A saved password an import is compared against (ExistingCredential+Vault). */
function existingCredential(credential: BrowserCredential): ExistingCredential {
    const { descriptor } = credential;
    return {
        id: descriptor.id,
        origin: descriptor.origin,
        username: descriptor.username,
        isWebForm: descriptor.scope.kind === "webForm",
        updatedAt: descriptor.updatedAt,
        lastUsedAt: descriptor.lastUsedAt,
        password: credential.password,
    };
}

/**
 * The Space's passwords once an import's suggested rows are taken
 * (BrowserCredentialImportReview.resolvedInventory with its default picks).
 */
function resolveImport(
    plan: CredentialImportPlan,
    existing: readonly BrowserCredential[],
    spaceID: Guid,
    isSynchronizable: boolean,
): { credentials: BrowserCredential[]; acceptedCount: number; skippedCount: number; rejectedCount: number } {
    const resolved = [...existing];
    const now = Date.now() / 1000;
    let acceptedCount = 0;
    for (const group of plan.groups) {
        if (group.suggestedRow === null) continue;
        const candidate = group.candidates.find((entry) => entry.rowNumber === group.suggestedRow);
        if (!candidate || !CredentialImportEffect.facts[candidate.effect].changesPasswords) continue;
        if (group.existingId !== null) {
            const index = resolved.findIndex((credential) => credential.descriptor.id === group.existingId);
            const held = resolved[index];
            if (!held) throw CredentialVaultError.malformedStoredCredential;
            resolved[index] = {
                descriptor: {
                    ...held.descriptor,
                    username: candidate.username,
                    displayName: candidate.displayName ?? held.descriptor.displayName,
                    updatedAt: now,
                },
                password: candidate.password,
            };
        } else {
            resolved.push({
                descriptor: {
                    id: crypto.randomUUID(),
                    spaceID,
                    origin: group.origin,
                    scope: { kind: "webForm" },
                    username: candidate.username,
                    displayName: candidate.displayName,
                    createdAt: now,
                    updatedAt: now,
                    lastUsedAt: null,
                    isSynchronizable,
                },
                password: candidate.password,
            });
        }
        acceptedCount += 1;
    }
    return {
        credentials: resolved,
        acceptedCount,
        skippedCount: plan.validRowCount - acceptedCount,
        rejectedCount: plan.rejections.length,
    };
}
