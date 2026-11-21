#include "chrome/browser/ui/crest/crest_credentials_linux.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ui/crest/crest_secret_service_linux.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/clipboard_sequence_number_token.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"

namespace crest {

namespace {

// The schema Crest's items carry, and their attributes. The service and
// account are the Mac's kSecAttrService and kSecAttrAccount; the metadata is
// its kSecAttrGeneric, and synchronizable its kSecAttrSynchronizable.
constexpr char kServiceAttribute[] = "crest-service";
constexpr char kAccountAttribute[] = "crest-account";
constexpr char kMetadataAttribute[] = "crest-metadata";
constexpr char kSynchronizableAttribute[] = "crest-synchronizable";

const SecretService::Schema& CredentialSchema() {
  static const base::NoDestructor<SecretService::Schema> schema(SecretService::Schema{
      .name = "com.pauldavis.crest.Credential",
      .attributes = {kServiceAttribute, kAccountAttribute, kMetadataAttribute, kSynchronizableAttribute},
  });
  return *schema;
}

// What the desktop's keyring lists the item as, as the Mac's itemLabel.
constexpr char kItemLabel[] = "Crest Password";

SecretService::Attributes Query(const std::string& service, const std::string& account) {
  SecretService::Attributes attributes{{kServiceAttribute, service}};
  if (!account.empty()) {
    attributes.emplace(kAccountAttribute, account);
  }
  return attributes;
}

SecretService::Attributes AttributesOf(const std::string& service, const CredentialItem& item) {
  return {{kServiceAttribute, service},
          {kAccountAttribute, item.account},
          {kMetadataAttribute, item.metadata},
          {kSynchronizableAttribute, item.synchronizable ? "true" : "false"}};
}

// The item a search found, or none for one missing what Crest writes.
std::optional<CredentialItem> Decode(const SecretService::Item& found) {
  const auto account = found.attributes.find(kAccountAttribute);
  const auto metadata = found.attributes.find(kMetadataAttribute);
  if (account == found.attributes.end() || metadata == found.attributes.end()) {
    return std::nullopt;
  }
  CredentialItem item;
  item.account = account->second;
  item.metadata = metadata->second;
  const auto synchronizable = found.attributes.find(kSynchronizableAttribute);
  item.synchronizable = synchronizable != found.attributes.end() && synchronizable->second == "true";
  item.secret = found.secret;
  return item;
}

// The clipboard's state when Crest last copied a password, while that copy
// is still what it holds as far as Crest knows.
std::optional<ui::ClipboardSequenceNumberToken>& LeasedClipboard() {
  static std::optional<ui::ClipboardSequenceNumberToken> leased;
  return leased;
}

void ExpireCopiedPassword(ui::ClipboardSequenceNumberToken copied) {
  std::optional<ui::ClipboardSequenceNumberToken>& leased = LeasedClipboard();
  ui::Clipboard* clipboard = ui::Clipboard::GetForCurrentThread();
  if (!leased || *leased != copied || !clipboard ||
      clipboard->GetSequenceNumber(ui::ClipboardBuffer::kCopyPaste) != copied) {
    return;
  }
  leased.reset();
  clipboard->Clear(ui::ClipboardBuffer::kCopyPaste);
}

}  // namespace

CredentialItem::CredentialItem() = default;
CredentialItem::CredentialItem(const CredentialItem&) = default;
CredentialItem::CredentialItem(CredentialItem&&) = default;
CredentialItem& CredentialItem::operator=(const CredentialItem&) = default;
CredentialItem& CredentialItem::operator=(CredentialItem&&) = default;
CredentialItem::~CredentialItem() = default;

// static
std::optional<std::vector<CredentialItem>> CredentialStore::Items(const std::string& service,
                                                                  const std::string& account, bool with_secrets) {
  SecretService* secrets = SecretService::Get();
  if (!secrets || service.empty()) {
    return std::nullopt;
  }
  std::optional<std::vector<SecretService::Item>> found =
      secrets->Search(CredentialSchema(), Query(service, account), with_secrets);
  if (!found) {
    return std::nullopt;
  }
  std::vector<CredentialItem> items;
  for (const SecretService::Item& entry : *found) {
    std::optional<CredentialItem> item = Decode(entry);
    // An item that lost its password reads as one the vault cannot read.
    if (item && with_secrets && !item->secret) {
      item->secret = std::string();
    }
    if (item) {
      items.push_back(std::move(*item));
    }
  }
  return items;
}

// static
bool CredentialStore::Upsert(const std::string& service, const CredentialItem& item) {
  SecretService* secrets = SecretService::Get();
  if (!secrets || service.empty() || item.account.empty() || !item.secret) {
    return false;
  }
  const SecretService::Attributes attributes = AttributesOf(service, item);
  if (!secrets->Store(CredentialSchema(), attributes, kItemLabel, *item.secret)) {
    return false;
  }
  // The Secret Service replaces only an item with the very same attributes,
  // so the account's item with its earlier descriptor goes now. libsecret
  // adds the schema's name to each item, so only Crest's own are compared.
  return secrets->Remove(CredentialSchema(), Query(service, item.account), [&](const SecretService::Item& found) {
    const std::optional<CredentialItem> held = Decode(found);
    return !held || held->metadata != item.metadata || held->synchronizable != item.synchronizable;
  });
}

// static
bool CredentialStore::Delete(const std::string& service, const std::string& account) {
  SecretService* secrets = SecretService::Get();
  if (!secrets || service.empty()) {
    return false;
  }
  return secrets->Remove(CredentialSchema(), Query(service, account), [](const SecretService::Item&) { return true; });
}

bool CopyPasswordForAWhile(const std::string& password, base::TimeDelta lifetime) {
  ui::Clipboard* clipboard = ui::Clipboard::GetForCurrentThread();
  if (!clipboard || password.empty()) {
    return false;
  }
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(base::UTF8ToUTF16(password));
    // Clipboard managers that honor it keep no history of a password.
    writer.MarkAsConfidential();
  }
  const ui::ClipboardSequenceNumberToken copied = clipboard->GetSequenceNumber(ui::ClipboardBuffer::kCopyPaste);
  LeasedClipboard() = copied;
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&ExpireCopiedPassword, copied), lifetime);
  return true;
}

}  // namespace crest
