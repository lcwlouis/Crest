#include "chrome/browser/ui/crest/crest_secret_service_linux.h"

#include <dlfcn.h>

#include <cstddef>
#include <cstdint>
#include <type_traits>
#include <utility>

#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"

namespace crest {

namespace {

// --- libsecret and glib, as libsecret's simple and item calls use them -----
// Declared here, from libsecret's and glib's stable ABI, so the build needs
// neither library's headers.

using gboolean = int;
using gpointer = void*;

struct GError {
  uint32_t domain;
  int code;
  char* message;
};

struct GList {
  gpointer data;
  GList* next;
  GList* prev;
};

struct GHashTable;

using GHashFunc = unsigned (*)(const void*);
using GEqualFunc = gboolean (*)(const void*, const void*);
using GDestroyNotify = void (*)(gpointer);

enum SecretSchemaAttributeType { kSecretSchemaAttributeString = 0 };

struct SecretSchemaAttribute {
  const char* name;
  SecretSchemaAttributeType type;
};

// libsecret's SecretSchema, whose layout is part of its ABI.
struct SecretSchema {
  const char* name;
  int flags;
  SecretSchemaAttribute attributes[32];
  int reserved;
  gpointer reserved1;
  gpointer reserved2;
  gpointer reserved3;
  gpointer reserved4;
  gpointer reserved5;
  gpointer reserved6;
  gpointer reserved7;
};

// SecretSearchFlags.
constexpr int kSearchAll = 1 << 1;
constexpr int kSearchUnlock = 1 << 2;
constexpr int kSearchLoadSecrets = 1 << 3;

// SECRET_COLLECTION_DEFAULT.
constexpr char kDefaultCollection[] = "default";

}  // namespace

struct SecretService::Library {
  GHashTable* (*hash_table_new_full)(GHashFunc, GEqualFunc, GDestroyNotify, GDestroyNotify) = nullptr;
  gboolean (*hash_table_insert)(GHashTable*, gpointer, gpointer) = nullptr;
  void (*hash_table_unref)(GHashTable*) = nullptr;
  GList* (*hash_table_get_keys)(GHashTable*) = nullptr;
  gpointer (*hash_table_lookup)(GHashTable*, const void*) = nullptr;
  unsigned (*str_hash)(const void*) = nullptr;
  gboolean (*str_equal)(const void*, const void*) = nullptr;
  void (*list_free)(GList*) = nullptr;
  void (*object_unref)(gpointer) = nullptr;
  void (*error_free)(GError*) = nullptr;
  void (*free)(gpointer) = nullptr;
  GList* (*service_search_sync)(gpointer service, const SecretSchema*, GHashTable*, int flags, gpointer cancellable,
                                GError**) = nullptr;
  GHashTable* (*item_get_attributes)(gpointer item) = nullptr;
  char* (*item_get_label)(gpointer item) = nullptr;
  gpointer (*item_get_secret)(gpointer item) = nullptr;
  gboolean (*item_delete_sync)(gpointer item, gpointer cancellable, GError**) = nullptr;
  const char* (*value_get)(gpointer value, size_t* length) = nullptr;
  void (*value_unref)(gpointer value) = nullptr;
  gboolean (*password_storev_sync)(const SecretSchema*, GHashTable*, const char* collection, const char* label,
                                   const char* password, gpointer cancellable, GError**) = nullptr;

  // libsecret, and the glib it brings, or null where either is missing.
  static Library* Load() {
    void* handle = dlopen("libsecret-1.so.0", RTLD_NOW | RTLD_GLOBAL);
    if (!handle) {
      LOG(WARNING) << "Crest cannot load libsecret; saved passwords are unavailable: " << dlerror();
      return nullptr;
    }
    auto* library = new Library;
    bool found = true;
    auto bind = [&](auto& function, const char* name) {
      function = reinterpret_cast<std::remove_reference_t<decltype(function)>>(dlsym(handle, name));
      found = found && function;
    };
    bind(library->hash_table_new_full, "g_hash_table_new_full");
    bind(library->hash_table_insert, "g_hash_table_insert");
    bind(library->hash_table_unref, "g_hash_table_unref");
    bind(library->hash_table_get_keys, "g_hash_table_get_keys");
    bind(library->hash_table_lookup, "g_hash_table_lookup");
    bind(library->str_hash, "g_str_hash");
    bind(library->str_equal, "g_str_equal");
    bind(library->list_free, "g_list_free");
    bind(library->object_unref, "g_object_unref");
    bind(library->error_free, "g_error_free");
    bind(library->free, "g_free");
    bind(library->service_search_sync, "secret_service_search_sync");
    bind(library->item_get_attributes, "secret_item_get_attributes");
    bind(library->item_get_label, "secret_item_get_label");
    bind(library->item_get_secret, "secret_item_get_secret");
    bind(library->item_delete_sync, "secret_item_delete_sync");
    bind(library->value_get, "secret_value_get");
    bind(library->value_unref, "secret_value_unref");
    bind(library->password_storev_sync, "secret_password_storev_sync");
    if (!found) {
      LOG(WARNING) << "Crest's libsecret lacks a call it needs; saved passwords are unavailable.";
      delete library;
      return nullptr;
    }
    return library;
  }

  // A table of `attributes`, borrowing their strings; unref it after use.
  GHashTable* Table(const SecretService::Attributes& attributes) const {
    GHashTable* table = hash_table_new_full(str_hash, str_equal, nullptr, nullptr);
    for (const auto& [name, value] : attributes) {
      hash_table_insert(table, const_cast<char*>(name.c_str()), const_cast<char*>(value.c_str()));
    }
    return table;
  }

  // Logs and frees a failure; false when there was none.
  bool Failed(GError* error, const char* call) const {
    if (!error) {
      return false;
    }
    LOG(WARNING) << "The Secret Service refused " << call << ": " << (error->message ? error->message : "");
    error_free(error);
    return true;
  }
};

namespace {

// `schema` as libsecret takes it.
SecretSchema Native(const SecretService::Schema& schema) {
  SecretSchema native{};
  native.name = schema.name;
  base::span<SecretSchemaAttribute> slots(native.attributes);
  size_t index = 0;
  // The list ends at an attribute with no name, which the zeroed schema has.
  for (const char* attribute : schema.attributes) {
    if (index + 1 >= slots.size()) {
      break;
    }
    slots[index++] = {attribute, kSecretSchemaAttributeString};
  }
  return native;
}

}  // namespace

SecretService::Item::Item() = default;
SecretService::Item::Item(const Item&) = default;
SecretService::Item::Item(Item&&) = default;
SecretService::Item& SecretService::Item::operator=(const Item&) = default;
SecretService::Item& SecretService::Item::operator=(Item&&) = default;
SecretService::Item::~Item() = default;

SecretService::SecretService(Library* library) : library_(library) {}

// static
SecretService* SecretService::Get() {
  static SecretService* const service = [] {
    Library* library = Library::Load();
    return library ? new SecretService(library) : nullptr;
  }();
  return service;
}

bool SecretService::ForEach(const Schema& schema, const Attributes& attributes, int flags,
                            base::FunctionRef<void(void* handle, const Item& item)> visit) {
  const SecretSchema native = Native(schema);
  GHashTable* table = library_->Table(attributes);
  GError* error = nullptr;
  GList* found = library_->service_search_sync(nullptr, &native, table, flags, nullptr, &error);
  library_->hash_table_unref(table);
  if (library_->Failed(error, "a search")) {
    return false;
  }
  for (GList* entry = found; entry; entry = entry->next) {
    gpointer handle = entry->data;
    Item item;
    if (char* label = library_->item_get_label(handle)) {
      item.label = label;
      library_->free(label);
    }
    if (GHashTable* held = library_->item_get_attributes(handle)) {
      GList* keys = library_->hash_table_get_keys(held);
      for (GList* key = keys; key; key = key->next) {
        const auto* value = static_cast<const char*>(library_->hash_table_lookup(held, key->data));
        if (key->data && value) {
          item.attributes.emplace(static_cast<const char*>(key->data), value);
        }
      }
      library_->list_free(keys);
      library_->hash_table_unref(held);
    }
    if (flags & kSearchLoadSecrets) {
      if (gpointer value = library_->item_get_secret(handle)) {
        size_t length = 0;
        const char* bytes = library_->value_get(value, &length);
        if (bytes) {
          // SAFETY: libsecret answers the value's bytes and their length.
          item.secret = UNSAFE_BUFFERS(std::string(bytes, length));
        }
        library_->value_unref(value);
      }
    }
    visit(handle, item);
    library_->object_unref(handle);
  }
  library_->list_free(found);
  return true;
}

std::optional<std::vector<SecretService::Item>> SecretService::Search(const Schema& schema,
                                                                      const Attributes& attributes,
                                                                      bool load_secrets) {
  std::vector<Item> items;
  const int flags = kSearchAll | (load_secrets ? kSearchUnlock | kSearchLoadSecrets : 0);
  if (!ForEach(schema, attributes, flags, [&](void*, const Item& item) { items.push_back(item); })) {
    return std::nullopt;
  }
  return items;
}

bool SecretService::Store(const Schema& schema, const Attributes& attributes, const std::string& label,
                          const std::string& secret) {
  const SecretSchema native = Native(schema);
  GHashTable* table = library_->Table(attributes);
  GError* error = nullptr;
  const gboolean stored = library_->password_storev_sync(&native, table, kDefaultCollection, label.c_str(),
                                                         secret.c_str(), nullptr, &error);
  library_->hash_table_unref(table);
  return !library_->Failed(error, "a store") && stored;
}

bool SecretService::Remove(const Schema& schema, const Attributes& attributes,
                           base::FunctionRef<bool(const Item&)> removes) {
  bool removed_all = true;
  const bool searched = ForEach(schema, attributes, kSearchAll | kSearchUnlock, [&](void* handle, const Item& item) {
    if (!removes(item)) {
      return;
    }
    GError* error = nullptr;
    const gboolean deleted = library_->item_delete_sync(handle, nullptr, &error);
    if (library_->Failed(error, "a delete") || !deleted) {
      removed_all = false;
    }
  });
  return searched && removed_all;
}

scoped_refptr<base::SequencedTaskRunner> SecretServiceSequence() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> sequence(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING, base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *sequence;
}

}  // namespace crest
