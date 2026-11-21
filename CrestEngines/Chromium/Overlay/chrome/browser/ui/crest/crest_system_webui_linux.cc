#include "chrome/browser/ui/crest/crest_system_webui_linux.h"

#include <optional>
#include <string>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "chrome/browser/ui/crest/crest_notifications_linux.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_message_handler.h"

namespace crest {

namespace {

// The core's page id the WebUI sent, in GuidText's spelling, which the
// binding and the windows key pages by; empty when it is not one.
std::string PageKey(const base::Value& value) {
  const std::optional<engine::Guid> id = value.is_string() ? ParseGuid(value.GetString()) : std::nullopt;
  return id ? GuidText(*id) : std::string();
}

class SystemUIHandler;

// Every page of chrome://crest open now.
std::vector<SystemUIHandler*>& SystemHandlers() {
  static base::NoDestructor<std::vector<SystemUIHandler*>> handlers;
  return *handlers;
}

class SystemUIHandler final : public content::WebUIMessageHandler {
 public:
  SystemUIHandler() { SystemHandlers().push_back(this); }
  SystemUIHandler(const SystemUIHandler&) = delete;
  SystemUIHandler& operator=(const SystemUIHandler&) = delete;
  ~SystemUIHandler() override { std::erase(SystemHandlers(), this); }

  // content::WebUIMessageHandler:
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "systemReady", base::BindRepeating(&SystemUIHandler::HandleSystemReady, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "relayoutInspector", base::BindRepeating(&SystemUIHandler::HandleRelayoutInspector, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "showsNotifications", base::BindRepeating(&SystemUIHandler::HandleShowsNotifications, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "showNotification", base::BindRepeating(&SystemUIHandler::HandleShowNotification, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "closeNotification", base::BindRepeating(&SystemUIHandler::HandleCloseNotification, base::Unretained(this)));
  }

  // Fires `event` to the page; false while it cannot hear it.
  bool Fire(const std::string& event, const base::Value& value) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener(event, value);
    return true;
  }

  content::WebContents* contents() { return web_ui()->GetWebContents(); }

  // The person clicked the notification `key` that `origin`'s page showed. A
  // window that closed since hands it to the browser window used last, whose
  // page heard the same notification posted.
  static void DeliverClick(base::WeakPtr<SystemUIHandler> origin, const std::string& key) {
    const base::Value clicked(key);
    if (origin && origin->Fire("crest-notification-clicked", clicked)) return;
    const std::vector<std::string> stacked = LinuxWindow::Stacked();
    LinuxWindow* front = stacked.empty() ? nullptr : LinuxWindow::Find(stacked.front());
    for (SystemUIHandler* handler : SystemHandlers()) {
      if (front && handler->contents() == front->ui_contents()) handler->Fire("crest-notification-clicked", clicked);
    }
  }

 private:
  LinuxWindow* Window() { return LinuxWindow::Drawing(web_ui()->GetWebContents()); }

  // The page listens for what the desktop tells it.
  void HandleSystemReady(const base::ListValue& args) { AllowJavascript(); }

  // Whether this page draws the browser window used last, the one that
  // shows the desktop's notifications. Every window's page hears each
  // notification the engine posts; that one alone shows and takes it down,
  // so each shows once.
  bool ShowsNotifications() {
    LinuxWindow* window = Window();
    if (!window || window->ui_contents() != web_ui()->GetWebContents()) return false;
    const std::vector<std::string> stacked = LinuxWindow::Stacked();
    return !stacked.empty() && stacked.front() == window->id();
  }

  // args: callback id. Answers whether this page's window shows the
  // notifications.
  void HandleShowsNotifications(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 1) return;
    ResolveJavascriptCallback(args[0], base::Value(ShowsNotifications()));
  }

  // args: callback id, a key the page names the notification by, its title,
  // the site that posted it, its body, whether it is silent. Answers
  // "shown", "declined" when the desktop did not take it, or "elsewhere"
  // when another window shows the notifications. A click fires
  // crest-notification-clicked with the key to this page.
  void HandleShowNotification(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 6 || !args[1].is_string() || !args[2].is_string() || !args[3].is_string() ||
        !args[4].is_string() || !args[5].is_bool()) {
      RejectJavascriptCallback(args[0], base::Value("showNotification takes a key, a title, a site, a body and silence."));
      return;
    }
    if (!ShowsNotifications()) {
      ResolveJavascriptCallback(args[0], base::Value("elsewhere"));
      return;
    }
    const std::string key = args[1].GetString();
    DesktopNotifications::Get().Show(
        key,
        DesktopNotifications::Delivery{.title = args[2].GetString(),
                                       .site = args[3].GetString(),
                                       .body = args[4].GetString(),
                                       .silent = args[5].GetBool()},
        base::BindOnce(&SystemUIHandler::AnswerShown, weak_factory_.GetWeakPtr(), args[0].Clone()),
        base::BindOnce(&DeliverClick, weak_factory_.GetWeakPtr(), key));
  }

  void AnswerShown(base::Value callback, bool shown) {
    if (IsJavascriptAllowed()) ResolveJavascriptCallback(callback, base::Value(shown ? "shown" : "declined"));
  }

  // args: the key of a notification the page showed, which goes.
  void HandleCloseNotification(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_string() || !ShowsNotifications()) return;
    DesktopNotifications::Get().Close(args[0].GetString());
  }

  // args: the core's id of a page whose docked inspector moved its split, as
  // InspectorLayoutChanged says. The window showing it places the page again.
  void HandleRelayoutInspector(const base::ListValue& args) {
    const std::string page = args.size() == 1 ? PageKey(args[0]) : std::string();
    LinuxWindow* window = Window();
    if (!page.empty() && window) window->RelayoutInspector(page);
  }

  base::WeakPtrFactory<SystemUIHandler> weak_factory_{this};
};

}  // namespace

std::unique_ptr<content::WebUIMessageHandler> CreateSystemUIHandler() {
  return std::make_unique<SystemUIHandler>();
}

}  // namespace crest
