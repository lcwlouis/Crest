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

class SystemUIHandler final : public content::WebUIMessageHandler {
 public:
  SystemUIHandler() = default;
  SystemUIHandler(const SystemUIHandler&) = delete;
  SystemUIHandler& operator=(const SystemUIHandler&) = delete;
  ~SystemUIHandler() override = default;

  // content::WebUIMessageHandler:
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "relayoutInspector", base::BindRepeating(&SystemUIHandler::HandleRelayoutInspector, base::Unretained(this)));
  }

 private:
  LinuxWindow* Window() { return LinuxWindow::Drawing(web_ui()->GetWebContents()); }

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
