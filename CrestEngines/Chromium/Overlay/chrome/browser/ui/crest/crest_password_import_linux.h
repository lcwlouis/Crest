#ifndef CHROME_BROWSER_UI_CREST_CREST_PASSWORD_IMPORT_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_PASSWORD_IMPORT_LINUX_H_

// The passwords another browser built on Chromium keeps on Linux, which
// setup imports, as the Mac's BrowserPasswordImportReader reads them. The
// core finds each profile's password stores (its Login Data files); this
// reads them. Chromium on Linux encrypts each password with AES-128-CBC
// under a key derived from a password: "v11" passwords from the one it keeps
// in the Secret Service under "<Browser> Safe Storage" (the Mac's Keychain
// item of that name), "v10" ones from the fixed "peanuts" it uses where no
// keyring is available.
//
// TODO(linux): Firefox and Zen keep passwords in logins.json under NSS
// (key4.db); the Mac's importer does not read them either.

#include <optional>
#include <string>
#include <vector>

namespace crest {

// One profile's password store, as the core found it (ImportPasswordStore).
struct PasswordImportStore {
  PasswordImportStore();
  PasswordImportStore(const PasswordImportStore&);
  PasswordImportStore& operator=(const PasswordImportStore&);
  ~PasswordImportStore();

  std::string id;
  std::string profile_name;
  std::string path;
};

// One saved login read from a store: where it came from, the address it
// signs in to as the browser wrote it, and, when read to import, the
// account and password.
struct ImportedLogin {
  ImportedLogin();
  ImportedLogin(const ImportedLogin&);
  ImportedLogin(ImportedLogin&&);
  ImportedLogin& operator=(const ImportedLogin&);
  ImportedLogin& operator=(ImportedLogin&&);
  ~ImportedLogin();

  std::string profile_id;
  std::string profile_name;
  std::string origin_url;
  std::string username;
  std::optional<std::string> password;
};

// Why the passwords could not be read, as the Mac's
// BrowserPasswordImportError names it.
enum class PasswordImportFailure {
  kUnreadableDatabase,
  kSafeStorageUnavailable,
};

struct PasswordImportResult {
  PasswordImportResult();
  PasswordImportResult(PasswordImportResult&&);
  PasswordImportResult& operator=(PasswordImportResult&&);
  ~PasswordImportResult();

  std::vector<ImportedLogin> logins;
  std::optional<PasswordImportFailure> failure;
};

// The logins `stores` keep, without their passwords, as the Mac's
// BrowserPasswordImportReader.candidates. Blocks on the disk.
PasswordImportResult ReadImportCandidates(const std::vector<PasswordImportStore>& stores);

// The logins `stores` keep with their passwords decrypted, the "v11" ones
// with the key the Secret Service keeps under `safe_storage`, as the Mac's
// BrowserPasswordImportReader.read. Blocks on the disk and the Secret
// Service: run it on `SecretServiceSequence()`.
PasswordImportResult ReadImportPasswords(const std::vector<PasswordImportStore>& stores,
                                         const std::string& safe_storage);

// The name of `failure` the WebUI reads.
const char* PasswordImportFailureName(PasswordImportFailure failure);

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_PASSWORD_IMPORT_LINUX_H_
