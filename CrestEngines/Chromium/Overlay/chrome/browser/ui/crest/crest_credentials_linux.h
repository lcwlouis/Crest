#ifndef CHROME_BROWSER_UI_CREST_CREST_CREDENTIALS_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_CREDENTIALS_LINUX_H_

// Crest's saved passwords on Linux, kept in the Secret Service as the Mac
// keeps them in the Keychain. The split is the Mac's: the core never holds a
// password, and decides from descriptors alone; the shell keeps the secrets
// and reads and writes them. On the Mac the shell's Keychain store
// (SecurityCredentialKeychainStore) is Swift beside the UI; on Linux the
// shell's native half is this browser process, so the store is here, and
// Crest's WebUI keeps the vault's rules (KeychainCredentialVault) over it,
// as the Mac's Swift does over its store.

#include <optional>
#include <string>
#include <vector>

#include "base/time/time.h"

namespace crest {

// One of Crest's saved passwords as the Secret Service keeps it, as the
// Mac's CredentialKeychainItem: the account (the credential's id) in the
// service (its Space's), the descriptor the vault encoded, whether it
// synchronizes, and the password when it was read.
struct CredentialItem {
  CredentialItem();
  CredentialItem(const CredentialItem&);
  CredentialItem(CredentialItem&&);
  CredentialItem& operator=(const CredentialItem&);
  CredentialItem& operator=(CredentialItem&&);
  ~CredentialItem();

  std::string account;
  std::string metadata;
  bool synchronizable = false;
  std::optional<std::string> secret;
};

// The store, as SecurityCredentialKeychainStore is the Mac's. Each item's
// attributes name its service and account and carry its descriptor (the
// metadata the Mac keeps in the item's generic attribute, which the Keychain
// does not encrypt either), so a list reads them without unlocking anything;
// its secret is the password. Every call blocks: run them on
// `SecretServiceSequence()`. None, or false, when the Secret Service cannot
// be reached or refuses, as the Keychain's errors do.
class CredentialStore {
 public:
  // The items of `service`, with their passwords when `with_secrets`, which
  // unlocks the collection when it must, as the desktop asks the person.
  // Only `account`'s when it is not empty.
  static std::optional<std::vector<CredentialItem>> Items(const std::string& service, const std::string& account,
                                                          bool with_secrets);
  // Changes `item` in place, or adds it when its account has none. The item
  // is written before the one it replaces goes, so no stop leaves the
  // account without its password.
  static bool Upsert(const std::string& service, const CredentialItem& item);
  // Deletes `account`'s item, or every item of `service` when it is empty.
  // Deleting what is not there succeeds, as the Keychain's not-found does.
  static bool Delete(const std::string& service, const std::string& account);
};

// Puts `password` on the clipboard, marked as a password for clipboard
// managers, and clears it after `lifetime` unless something else was copied
// since, as the Mac's BrowserCredentialClipboard does. False when it could
// not be written. Runs on the UI thread.
bool CopyPasswordForAWhile(const std::string& password, base::TimeDelta lifetime);

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_CREDENTIALS_LINUX_H_
