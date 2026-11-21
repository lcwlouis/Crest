#ifndef CHROME_BROWSER_UI_CREST_CREST_SECRET_SERVICE_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_SECRET_SERVICE_LINUX_H_

// The desktop's Secret Service (GNOME Keyring, KWallet's Secret Service
// interface, KeePassXC), Linux's counterpart of the Mac's Keychain, reached
// through libsecret. libsecret is loaded when first asked for, as Chromium's
// own key storage loads it, so Crest builds without its headers and runs
// where it is missing: every call then fails, as a Keychain that refuses
// does. Each call blocks on D-Bus, and on the desktop's unlock prompt when
// it asks to unlock, so it runs only on `SecretServiceSequence()`, which
// also makes Crest's writes take turns.

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/function_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/task/sequenced_task_runner.h"

namespace crest {

class SecretService {
 public:
  using Attributes = std::map<std::string, std::string>;

  // A kind of item: the schema's name, which libsecret keeps with each item
  // as `xdg:schema`, and the names of its attributes, all strings.
  struct Schema {
    const char* name;
    std::vector<const char*> attributes;
  };

  // One item a search found: its label, its attributes, and its secret when
  // the search loaded secrets.
  struct Item {
    Item();
    Item(const Item&);
    Item(Item&&);
    Item& operator=(const Item&);
    Item& operator=(Item&&);
    ~Item();

    std::string label;
    Attributes attributes;
    std::optional<std::string> secret;
  };

  // The service, or null where libsecret cannot be loaded.
  static SecretService* Get();

  SecretService(const SecretService&) = delete;
  SecretService& operator=(const SecretService&) = delete;

  // Every item of `schema` whose attributes include `attributes`, from every
  // collection. Locked items are listed without asking to unlock them unless
  // `load_secrets`, which unlocks what it must, asking the person, and reads
  // each item's secret. None when the service cannot be asked or refuses.
  std::optional<std::vector<Item>> Search(const Schema& schema, const Attributes& attributes, bool load_secrets);

  // Stores `secret` under `attributes` in the default collection, replacing
  // the item whose attributes are exactly these. False when it is not stored.
  bool Store(const Schema& schema, const Attributes& attributes, const std::string& label, const std::string& secret);

  // Deletes every item of `schema` whose attributes include `attributes` and
  // that `removes` chooses. False when one could not be found or deleted;
  // the others are deleted all the same.
  bool Remove(const Schema& schema, const Attributes& attributes, base::FunctionRef<bool(const Item&)> removes);

 private:
  struct Library;

  explicit SecretService(Library* library);

  // Runs `visit` on each item `Search` and `Remove` find, with libsecret's
  // own item, which `visit` may delete. False when the search failed.
  bool ForEach(const Schema& schema, const Attributes& attributes, int flags,
               base::FunctionRef<void(void* handle, const Item& item)> visit);

  Library* const library_;
};

// The sequence every Secret Service call runs on.
scoped_refptr<base::SequencedTaskRunner> SecretServiceSequence();

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_SECRET_SERVICE_LINUX_H_
