#include "chrome/browser/ui/crest/crest_password_import_linux.h"

#include <dlfcn.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <type_traits>
#include <utility>

#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/files/file.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/notreached.h"
#include "base/strings/string_util.h"
#include "chrome/browser/ui/crest/crest_secret_service_linux.h"
#include "third_party/boringssl/src/include/openssl/cipher.h"
#include "third_party/boringssl/src/include/openssl/evp.h"

namespace crest {

namespace {

// As the Mac's BrowserPasswordImportReader.
constexpr int64_t kMaximumDatabaseByteCount = int64_t{512} * 1024 * 1024;
constexpr size_t kMaximumPasswordCount = 100'000;

// --- SQLite ------------------------------------------------------------------
// The system's SQLite, loaded when first asked for, as the Mac's reader uses
// the system's: Chromium's own is built for its //sql and not shared.

struct sqlite3;
struct sqlite3_stmt;

constexpr int kSqliteOk = 0;
constexpr int kSqliteRow = 100;
constexpr int kSqliteDone = 101;
constexpr int kSqliteOpenReadOnly = 0x00000001;
constexpr int kSqliteOpenFullMutex = 0x00010000;
constexpr int kSqliteLimitLength = 0;
constexpr int kSqliteLimitSqlLength = 1;
constexpr int kSqliteLimitColumn = 2;
constexpr int kSqliteLimitAttached = 7;

struct Sqlite {
  int (*open_v2)(const char*, sqlite3**, int, const char*) = nullptr;
  int (*close)(sqlite3*) = nullptr;
  int (*busy_timeout)(sqlite3*, int) = nullptr;
  int (*exec)(sqlite3*, const char*, void*, void*, char**) = nullptr;
  int (*limit)(sqlite3*, int, int) = nullptr;
  int (*prepare_v2)(sqlite3*, const char*, int, sqlite3_stmt**, const char**) = nullptr;
  int (*bind_int)(sqlite3_stmt*, int, int) = nullptr;
  int (*step)(sqlite3_stmt*) = nullptr;
  const unsigned char* (*column_text)(sqlite3_stmt*, int) = nullptr;
  const void* (*column_blob)(sqlite3_stmt*, int) = nullptr;
  int (*column_bytes)(sqlite3_stmt*, int) = nullptr;
  int (*finalize)(sqlite3_stmt*) = nullptr;

  // The system's SQLite, or null where it is missing.
  static const Sqlite* Get() {
    static const Sqlite* const sqlite = []() -> const Sqlite* {
      void* handle = dlopen("libsqlite3.so.0", RTLD_NOW | RTLD_LOCAL);
      if (!handle) {
        LOG(WARNING) << "Crest cannot load SQLite to read another browser's passwords: " << dlerror();
        return nullptr;
      }
      auto* loaded = new Sqlite;
      bool found = true;
      auto bind = [&](auto& function, const char* name) {
        function = reinterpret_cast<std::remove_reference_t<decltype(function)>>(dlsym(handle, name));
        found = found && function;
      };
      bind(loaded->open_v2, "sqlite3_open_v2");
      bind(loaded->close, "sqlite3_close");
      bind(loaded->busy_timeout, "sqlite3_busy_timeout");
      bind(loaded->exec, "sqlite3_exec");
      bind(loaded->limit, "sqlite3_limit");
      bind(loaded->prepare_v2, "sqlite3_prepare_v2");
      bind(loaded->bind_int, "sqlite3_bind_int");
      bind(loaded->step, "sqlite3_step");
      bind(loaded->column_text, "sqlite3_column_text");
      bind(loaded->column_blob, "sqlite3_column_blob");
      bind(loaded->column_bytes, "sqlite3_column_bytes");
      bind(loaded->finalize, "sqlite3_finalize");
      if (!found) {
        delete loaded;
        return nullptr;
      }
      return loaded;
    }();
    return sqlite;
  }
};

// One login as the store keeps it, its password still encrypted.
struct EncryptedLogin {
  std::string origin_url;
  std::string username;
  std::string encrypted_password;
};

bool HasVersionPrefix(const std::string& encrypted, const char* version) {
  return encrypted.size() > 3 && encrypted.starts_with(version);
}

// The logins `path` keeps, at most `limit`, as the Mac's
// BrowserPasswordSQLiteDatabase reads them: read only, with SQLite's limits
// narrowed to what a password store needs. None when the file cannot be read.
std::optional<std::vector<EncryptedLogin>> EncryptedLogins(const base::FilePath& path, size_t limit) {
  const Sqlite* sqlite = Sqlite::Get();
  base::File::Info info;
  if (!sqlite || !base::GetFileInfo(path, &info) || info.is_directory || info.size > kMaximumDatabaseByteCount) {
    return std::nullopt;
  }
  sqlite3* database = nullptr;
  if (sqlite->open_v2(path.value().c_str(), &database, kSqliteOpenReadOnly | kSqliteOpenFullMutex, nullptr) !=
          kSqliteOk ||
      !database) {
    if (database) {
      sqlite->close(database);
    }
    return std::nullopt;
  }
  sqlite->busy_timeout(database, 1000);
  sqlite->exec(database, "PRAGMA query_only = ON", nullptr, nullptr, nullptr);
  sqlite->exec(database, "PRAGMA trusted_schema = OFF", nullptr, nullptr, nullptr);
  sqlite->limit(database, kSqliteLimitLength, 16 * 1024 * 1024);
  sqlite->limit(database, kSqliteLimitSqlLength, 64 * 1024);
  sqlite->limit(database, kSqliteLimitColumn, 64);
  sqlite->limit(database, kSqliteLimitAttached, 0);

  constexpr char kQuery[] =
      "SELECT origin_url, username_value, password_value FROM logins "
      "WHERE blacklisted_by_user = 0 AND username_value <> '' AND length(password_value) > 3 LIMIT ?";
  sqlite3_stmt* statement = nullptr;
  if (sqlite->prepare_v2(database, kQuery, -1, &statement, nullptr) != kSqliteOk || !statement) {
    sqlite->close(database);
    return std::nullopt;
  }
  sqlite->bind_int(statement, 1, static_cast<int>(std::min<size_t>(limit, INT32_MAX)));

  // A column's bytes, at most `maximum` of them; none for an empty or longer one.
  auto column = [&](int index, size_t maximum) -> std::optional<std::string> {
    const int count = sqlite->column_bytes(statement, index);
    const void* bytes = index == 2 ? sqlite->column_blob(statement, index)
                                   : static_cast<const void*>(sqlite->column_text(statement, index));
    if (!bytes || count <= 0 || static_cast<size_t>(count) > maximum) {
      return std::nullopt;
    }
    // SAFETY: SQLite answers the column's bytes and their count, which stay
    // valid until the next step.
    return UNSAFE_BUFFERS(std::string(static_cast<const char*>(bytes), static_cast<size_t>(count)));
  };

  std::vector<EncryptedLogin> logins;
  std::optional<std::vector<EncryptedLogin>> answer;
  while (true) {
    const int result = sqlite->step(statement);
    if (result == kSqliteDone) {
      answer = std::move(logins);
      break;
    }
    if (result != kSqliteRow) {
      break;
    }
    std::optional<std::string> origin_url = column(0, 1024 * 1024);
    std::optional<std::string> username = column(1, 1024 * 1024);
    std::optional<std::string> encrypted = column(2, 16 * 1024 * 1024);
    if (!origin_url || !username || !encrypted ||
        !(HasVersionPrefix(*encrypted, "v10") || HasVersionPrefix(*encrypted, "v11"))) {
      continue;
    }
    logins.push_back({std::move(*origin_url), std::move(*username), std::move(*encrypted)});
  }
  sqlite->finalize(statement);
  sqlite->close(database);
  return answer;
}

// --- Chromium's password encryption on Linux ---------------------------------

using Key = std::array<uint8_t, 16>;

// The key Chromium derives from `password`: PBKDF2-HMAC-SHA1 over "saltysalt"
// with one iteration on Linux (the Mac's 1003).
std::optional<Key> DeriveKey(const std::string& password) {
  static constexpr char kSalt[] = "saltysalt";
  Key key{};
  if (!PKCS5_PBKDF2_HMAC_SHA1(password.data(), password.size(), reinterpret_cast<const uint8_t*>(kSalt),
                              sizeof(kSalt) - 1, 1, key.size(), key.data())) {
    return std::nullopt;
  }
  return key;
}

// `encrypted` after its three-character version, decrypted with AES-128-CBC
// and an IV of sixteen spaces; none when it does not decrypt.
std::optional<std::string> Decrypt(const std::string& encrypted, const Key& key) {
  if (encrypted.size() <= 3) {
    return std::nullopt;
  }
  const base::span<const uint8_t> ciphertext = base::as_byte_span(encrypted).subspan(size_t{3});
  std::array<uint8_t, 16> iv;
  iv.fill(' ');
  bssl::ScopedEVP_CIPHER_CTX context;
  if (!EVP_DecryptInit_ex(context.get(), EVP_aes_128_cbc(), nullptr, key.data(), iv.data())) {
    return std::nullopt;
  }
  std::string plaintext(ciphertext.size() + 16, '\0');
  base::span<uint8_t> output = base::as_writable_byte_span(plaintext);
  int updated = 0;
  int finished = 0;
  if (!EVP_DecryptUpdate(context.get(), output.data(), &updated, ciphertext.data(),
                         static_cast<int>(ciphertext.size())) ||
      updated < 0 ||
      !EVP_DecryptFinal_ex(context.get(), output.subspan(static_cast<size_t>(updated)).data(), &finished) ||
      finished < 0) {
    return std::nullopt;
  }
  plaintext.resize(static_cast<size_t>(updated) + static_cast<size_t>(finished));
  return plaintext;
}

// The password Chromium-family browsers keep in the Secret Service under
// `label` ("Chrome Safe Storage" and the others the core names), with the
// schemas their key storage has written; none when no such item is there or
// the service cannot be asked. Only that browser's item is unlocked and read.
std::optional<std::string> SafeStoragePassword(const std::string& label) {
  SecretService* secrets = SecretService::Get();
  if (!secrets || label.empty()) {
    return std::nullopt;
  }
  static const base::NoDestructor<std::vector<SecretService::Schema>> schemas(std::vector<SecretService::Schema>{
      {.name = "chrome_libsecret_os_crypt_password_v2", .attributes = {"application"}},
      {.name = "chrome_libsecret_os_crypt_password", .attributes = {"application"}},
  });
  for (const SecretService::Schema& schema : *schemas) {
    std::optional<std::vector<SecretService::Item>> listed = secrets->Search(schema, {}, /*load_secrets=*/false);
    if (!listed) {
      continue;
    }
    for (const SecretService::Item& item : *listed) {
      const auto application = item.attributes.find("application");
      if (item.label != label || application == item.attributes.end()) {
        continue;
      }
      std::optional<std::vector<SecretService::Item>> read =
          secrets->Search(schema, {{"application", application->second}}, /*load_secrets=*/true);
      if (!read) {
        continue;
      }
      for (const SecretService::Item& found : *read) {
        if (found.label == label && found.secret && !found.secret->empty()) {
          return found.secret;
        }
      }
    }
  }
  return std::nullopt;
}

// Reads every store into `result`, each login through `take`, until the most
// a read may bring; a store that cannot be read is passed over, and the
// read fails only when none can be.
template <typename Take>
void ReadStores(const std::vector<PasswordImportStore>& stores, PasswordImportResult& result, Take take) {
  size_t readable = 0;
  for (const PasswordImportStore& store : stores) {
    if (result.logins.size() >= kMaximumPasswordCount) {
      break;
    }
    std::optional<std::vector<EncryptedLogin>> logins =
        EncryptedLogins(base::FilePath(store.path), kMaximumPasswordCount - result.logins.size());
    if (!logins) {
      continue;
    }
    ++readable;
    for (EncryptedLogin& encrypted : *logins) {
      ImportedLogin login;
      login.profile_id = store.id;
      login.profile_name = store.profile_name;
      login.origin_url = std::move(encrypted.origin_url);
      login.username = std::move(encrypted.username);
      if (take(encrypted.encrypted_password, login)) {
        result.logins.push_back(std::move(login));
      }
      if (result.failure) {
        return;
      }
    }
  }
  if (!stores.empty() && readable == 0) {
    result.failure = PasswordImportFailure::kUnreadableDatabase;
  }
}

}  // namespace

PasswordImportStore::PasswordImportStore() = default;
PasswordImportStore::PasswordImportStore(const PasswordImportStore&) = default;
PasswordImportStore& PasswordImportStore::operator=(const PasswordImportStore&) = default;
PasswordImportStore::~PasswordImportStore() = default;

ImportedLogin::ImportedLogin() = default;
ImportedLogin::ImportedLogin(const ImportedLogin&) = default;
ImportedLogin::ImportedLogin(ImportedLogin&&) = default;
ImportedLogin& ImportedLogin::operator=(const ImportedLogin&) = default;
ImportedLogin& ImportedLogin::operator=(ImportedLogin&&) = default;
ImportedLogin::~ImportedLogin() = default;

PasswordImportResult::PasswordImportResult() = default;
PasswordImportResult::PasswordImportResult(PasswordImportResult&&) = default;
PasswordImportResult& PasswordImportResult::operator=(PasswordImportResult&&) = default;
PasswordImportResult::~PasswordImportResult() = default;

PasswordImportResult ReadImportCandidates(const std::vector<PasswordImportStore>& stores) {
  PasswordImportResult result;
  ReadStores(stores, result, [](const std::string&, ImportedLogin&) { return true; });
  return result;
}

PasswordImportResult ReadImportPasswords(const std::vector<PasswordImportStore>& stores,
                                         const std::string& safe_storage) {
  PasswordImportResult result;
  // "v10" passwords take the fixed key; the Secret Service is asked for the
  // browser's own only once a "v11" one needs it.
  const std::optional<Key> fixed_key = DeriveKey("peanuts");
  std::optional<Key> stored_key;
  bool asked = false;
  ReadStores(stores, result, [&](const std::string& encrypted, ImportedLogin& login) {
    const Key* key = nullptr;
    if (HasVersionPrefix(encrypted, "v11")) {
      if (!asked) {
        asked = true;
        if (std::optional<std::string> password = SafeStoragePassword(safe_storage)) {
          stored_key = DeriveKey(*password);
        }
        if (!stored_key) {
          result.failure = PasswordImportFailure::kSafeStorageUnavailable;
          return false;
        }
      }
      key = stored_key ? &*stored_key : nullptr;
    } else if (fixed_key) {
      key = &*fixed_key;
    }
    std::optional<std::string> password = key ? Decrypt(encrypted, *key) : std::nullopt;
    if (!password || password->empty() || !base::IsStringUTF8(*password)) {
      return false;
    }
    login.password = std::move(password);
    return true;
  });
  if (result.failure) {
    result.logins.clear();
  }
  return result;
}

const char* PasswordImportFailureName(PasswordImportFailure failure) {
  switch (failure) {
    case PasswordImportFailure::kUnreadableDatabase:
      return "unreadableDatabase";
    case PasswordImportFailure::kSafeStorageUnavailable:
      return "safeStorageUnavailable";
  }
  NOTREACHED();
}

}  // namespace crest
