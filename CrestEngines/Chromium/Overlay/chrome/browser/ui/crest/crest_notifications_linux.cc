#include "chrome/browser/ui/crest/crest_notifications_linux.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/strings/escape.h"
#include "components/dbus/thread_linux/dbus_thread_linux.h"
#include "dbus/bus.h"
#include "dbus/message.h"
#include "dbus/object_path.h"
#include "dbus/object_proxy.h"
#include "third_party/skia/include/core/SkColor.h"

namespace crest {

namespace {

constexpr char kService[] = "org.freedesktop.Notifications";
constexpr char kPath[] = "/org/freedesktop/Notifications";
constexpr char kInterface[] = "org.freedesktop.Notifications";
// The action the desktop invokes when the person clicks the notification
// itself rather than one of its buttons.
constexpr char kDefaultAction[] = "default";

}  // namespace

// static
DesktopNotifications& DesktopNotifications::Get() {
  static base::NoDestructor<DesktopNotifications> notifications;
  return *notifications;
}

DesktopNotifications::DesktopNotifications() = default;
DesktopNotifications::~DesktopNotifications() = default;

dbus::ObjectProxy* DesktopNotifications::Service() {
  if (service_) return service_;
  bus_ = dbus_thread_linux::GetSharedSessionBus();
  if (!bus_) return nullptr;
  service_ = bus_->GetObjectProxy(kService, dbus::ObjectPath(kPath));
  service_->ConnectToSignal(kInterface, "ActionInvoked",
                            base::BindRepeating(&DesktopNotifications::ActionInvoked, weak_factory_.GetWeakPtr()),
                            base::DoNothing());
  service_->ConnectToSignal(kInterface, "NotificationClosed",
                            base::BindRepeating(&DesktopNotifications::Closed, weak_factory_.GetWeakPtr()),
                            base::DoNothing());
  dbus::MethodCall capabilities(kInterface, "GetCapabilities");
  service_->CallMethod(&capabilities, dbus::ObjectProxy::TIMEOUT_USE_DEFAULT,
                       base::BindOnce(&DesktopNotifications::Capabilities, weak_factory_.GetWeakPtr()));
  return service_;
}

void DesktopNotifications::Capabilities(dbus::Response* response) {
  if (!response) return;
  dbus::MessageReader reader(response);
  std::vector<std::string> capabilities;
  if (!reader.PopArrayOfStrings(&capabilities)) return;
  reads_markup_ = std::ranges::find(capabilities, "body-markup") != capabilities.end();
}

// The Mac shows the site as the notification's subtitle; the desktop has
// none, so it leads the body, as Chromium's own Linux notifications show it.
void DesktopNotifications::Show(const std::string& key,
                                const Delivery& delivery,
                                base::OnceCallback<void(bool)> shown,
                                base::OnceClosure clicked) {
  dbus::ObjectProxy* service = Service();
  if (!service) {
    std::move(shown).Run(false);
    return;
  }
  Shown& entry = shown_[key];
  const uint32_t replaces = entry.id;
  entry.generation = ++generations_;
  entry.clicked = std::move(clicked);

  const auto text = [this](const std::string& value) {
    return reads_markup_ ? base::EscapeForHTML(value) : value;
  };
  std::string body = text(delivery.site);
  if (!delivery.body.empty()) body += "\n" + text(delivery.body);

  dbus::MethodCall notify(kInterface, "Notify");
  dbus::MessageWriter writer(&notify);
  writer.AppendString("Crest");
  writer.AppendUint32(replaces);
  writer.AppendString(std::string());
  writer.AppendString(delivery.title);
  writer.AppendString(body);
  writer.AppendArrayOfStrings({kDefaultAction, "Open"});
  dbus::MessageWriter hints(nullptr);
  writer.OpenArray("{sv}", &hints);
  if (delivery.silent) {
    dbus::MessageWriter hint(nullptr);
    hints.OpenDictEntry(&hint);
    hint.AppendString("suppress-sound");
    hint.AppendVariantOfBool(true);
    hints.CloseContainer(&hint);
  }
  if (!delivery.icon.drawsNothing()) {
    // The site's icon as the specification's raw image: width, height, row
    // stride, alpha, bits per sample, channels and RGBA bytes, unpremultiplied.
    const SkBitmap& icon = delivery.icon;
    std::vector<uint8_t> rgba;
    rgba.reserve(static_cast<size_t>(icon.width()) * icon.height() * 4);
    for (int y = 0; y < icon.height(); ++y) {
      for (int x = 0; x < icon.width(); ++x) {
        const SkColor color = icon.getColor(x, y);
        rgba.insert(rgba.end(), {static_cast<uint8_t>(SkColorGetR(color)), static_cast<uint8_t>(SkColorGetG(color)),
                                 static_cast<uint8_t>(SkColorGetB(color)), static_cast<uint8_t>(SkColorGetA(color))});
      }
    }
    dbus::MessageWriter hint(nullptr);
    hints.OpenDictEntry(&hint);
    hint.AppendString("image-data");
    dbus::MessageWriter variant(nullptr);
    hint.OpenVariant("(iiibiiay)", &variant);
    dbus::MessageWriter image(nullptr);
    variant.OpenStruct(&image);
    image.AppendInt32(icon.width());
    image.AppendInt32(icon.height());
    image.AppendInt32(icon.width() * 4);
    image.AppendBool(true);
    image.AppendInt32(8);
    image.AppendInt32(4);
    image.AppendArrayOfBytes(rgba);
    variant.CloseContainer(&image);
    hint.CloseContainer(&variant);
    hints.CloseContainer(&hint);
  }
  writer.CloseContainer(&hints);
  // The desktop decides how long it shows.
  writer.AppendInt32(-1);
  service->CallMethod(&notify, dbus::ObjectProxy::TIMEOUT_USE_DEFAULT,
                      base::BindOnce(&DesktopNotifications::Notified, weak_factory_.GetWeakPtr(), key,
                                     entry.generation, std::move(shown)));
}

void DesktopNotifications::Notified(std::string key,
                                    uint64_t generation,
                                    base::OnceCallback<void(bool)> shown,
                                    dbus::Response* response) {
  uint32_t id = 0;
  if (response) {
    dbus::MessageReader reader(response);
    if (!reader.PopUint32(&id)) id = 0;
  }
  auto found = shown_.find(key);
  // Taken down, or shown again, while the desktop answered: the notification
  // it numbered goes at once.
  if (found == shown_.end() || found->second.generation != generation) {
    if (id) CloseId(id);
    std::move(shown).Run(false);
    return;
  }
  if (!id) {
    shown_.erase(found);
    std::move(shown).Run(false);
    return;
  }
  found->second.id = id;
  std::move(shown).Run(true);
}

void DesktopNotifications::Close(const std::string& key) {
  auto found = shown_.find(key);
  if (found == shown_.end()) return;
  const uint32_t id = found->second.id;
  shown_.erase(found);
  if (id) CloseId(id);
}

void DesktopNotifications::CloseId(uint32_t id) {
  dbus::ObjectProxy* service = Service();
  if (!service) return;
  dbus::MethodCall close(kInterface, "CloseNotification");
  dbus::MessageWriter writer(&close);
  writer.AppendUint32(id);
  service->CallMethod(&close, dbus::ObjectProxy::TIMEOUT_USE_DEFAULT, base::DoNothing());
}

std::map<std::string, DesktopNotifications::Shown>::iterator DesktopNotifications::Showing(uint32_t id) {
  return std::ranges::find_if(shown_, [id](const auto& entry) { return entry.second.id == id; });
}

// The person clicked the notification: it goes, and Crest hears it once.
void DesktopNotifications::ActionInvoked(dbus::Signal* signal) {
  dbus::MessageReader reader(signal);
  uint32_t id = 0;
  std::string action;
  if (!reader.PopUint32(&id) || !reader.PopString(&action) || !id) return;
  auto found = Showing(id);
  if (found == shown_.end() || (action != kDefaultAction && action != "Open")) return;
  base::OnceClosure clicked = std::move(found->second.clicked);
  shown_.erase(found);
  CloseId(id);
  if (clicked) std::move(clicked).Run();
}

// The desktop took it down: it expired, or the person dismissed it, which the
// document does not hear, as on the Mac.
void DesktopNotifications::Closed(dbus::Signal* signal) {
  dbus::MessageReader reader(signal);
  uint32_t id = 0;
  if (!reader.PopUint32(&id) || !id) return;
  auto found = Showing(id);
  if (found != shown_.end()) shown_.erase(found);
}

}  // namespace crest
