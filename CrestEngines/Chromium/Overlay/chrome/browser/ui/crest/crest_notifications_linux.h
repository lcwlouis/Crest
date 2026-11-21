#ifndef CHROME_BROWSER_UI_CREST_CREST_NOTIFICATIONS_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_NOTIFICATIONS_LINUX_H_

// The desktop's notifications, which Crest shows its pages' and profiles'
// web notifications through on Linux, as the Mac shows them through
// UNUserNotificationCenter. It speaks the freedesktop notification service
// (org.freedesktop.Notifications) on the session bus, as Chromium's own Linux
// bridge does, so the notifications are Crest's and a click comes back to
// Crest rather than to the document directly: the WebUI brings the page
// forward and answers the engine (AnswerWebNotification).

#include <cstdint>
#include <map>
#include <memory>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"

namespace dbus {
class Bus;
class ObjectProxy;
class Response;
class Signal;
}  // namespace dbus

namespace crest {

class DesktopNotifications final {
 public:
  // One notification to show, as the Mac's BrowserHostedWebNotificationDelivery.
  struct Delivery {
    std::string title;
    // The site that posted it, which the Mac shows as the subtitle.
    std::string site;
    std::string body;
    bool silent = false;
  };

  static DesktopNotifications& Get();

  DesktopNotifications(const DesktopNotifications&) = delete;
  DesktopNotifications& operator=(const DesktopNotifications&) = delete;

  // Shows `delivery` under `key`, in place of what shows under it now, then
  // answers whether the desktop took it. `clicked` runs once if the person
  // clicks it.
  void Show(const std::string& key,
            const Delivery& delivery,
            base::OnceCallback<void(bool)> shown,
            base::OnceClosure clicked);
  // Takes down what shows under `key`.
  void Close(const std::string& key);

 private:
  friend class base::NoDestructor<DesktopNotifications>;

  // A notification asked of the desktop, which numbers it once it answers.
  struct Shown {
    // Which of the notifications shown under one key this is.
    uint64_t generation = 0;
    uint32_t id = 0;
    base::OnceClosure clicked;
  };

  DesktopNotifications();
  ~DesktopNotifications();

  // The service on the session bus, connected the first time it is needed.
  dbus::ObjectProxy* Service();
  void Notified(std::string key,
                uint64_t generation,
                base::OnceCallback<void(bool)> shown,
                dbus::Response* response);
  void Capabilities(dbus::Response* response);
  void ActionInvoked(dbus::Signal* signal);
  void Closed(dbus::Signal* signal);
  void CloseId(uint32_t id);
  // The key shown under the desktop's `id`, or none.
  std::map<std::string, Shown>::iterator Showing(uint32_t id);

  scoped_refptr<dbus::Bus> bus_;
  raw_ptr<dbus::ObjectProxy> service_ = nullptr;
  std::map<std::string, Shown> shown_;
  // Whether the service reads markup in a body, which then escapes what the
  // page wrote; it is assumed until the service says otherwise.
  bool reads_markup_ = true;
  uint64_t generations_ = 0;
  base::WeakPtrFactory<DesktopNotifications> weak_factory_{this};
};

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_NOTIFICATIONS_LINUX_H_
