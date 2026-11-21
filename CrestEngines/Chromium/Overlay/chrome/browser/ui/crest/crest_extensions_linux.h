#ifndef CHROME_BROWSER_UI_CREST_CREST_EXTENSIONS_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_EXTENSIONS_LINUX_H_

// Crest's extension surfaces on Linux: what the Mac shell gives the engine
// through CrestChromiumHost.h (runExtension:, extensionPopupAnchor:,
// openSidePanel:, closeSidePanel:, dispatchExtensionShortcut:) and Crest's
// WebUI asks for. An action's popup and an extension's side panel are views
// of the Crest window they belong to, placed where the window's WebUI says:
// the popup under the control it was opened from, over everything, and the
// side panel in the card the WebUI keeps beside the page. Neither is ever a
// window of its own. Everything else (what the toolbar lists, installs, the
// core's changes) is the portable binding's and goes through the core.

#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback_forward.h"

class Browser;
class BrowserWindowInterface;
class Profile;

namespace content {
class WebUIMessageHandler;
}
namespace extensions {
class Extension;
class ExtensionHost;
}  // namespace extensions
namespace input {
struct NativeWebKeyboardEvent;
}

namespace crest {

class LinuxWindow;

// The handler of the extension messages a window's WebUI sends: running an
// action from a control, where each pinned control is, and the side panel
// card's document. CrestUI adds one to each chrome://crest page.
std::unique_ptr<content::WebUIMessageHandler> MakeExtensionsHandler();

// `chrome.action.openPopup()` over the page `browser` shows, from the control
// the window's WebUI last named for the extension: its pinned control, or
// the address field. False as the Mac's OpenExtensionActionPopup is false.
bool OpenExtensionPopupFromEngine(BrowserWindowInterface& browser, const extensions::Extension& extension,
                                  base::OnceCallback<void(extensions::ExtensionHost*)> shown);

// The engine lets `page` go: its popup and side panel go first.
void ReleaseExtensionViews(const std::string& page);
// A profile is being let go of: the popup opened with no page goes with it.
void ReleaseSpaceExtensionPopup();
// The extension retracted its side panel for `profile`'s tabs, or for the tab
// `tab` names: each card it showed closes, and its window's WebUI hears it.
void RetractExtensionSidePanels(Profile* profile, const std::string& extension_id, std::optional<int> tab);

// chrome.commands: a key the window's page and Crest's own shortcuts left. A
// named command goes to its extension; an `_execute_action` binding is run
// by the WebUI as a click on the extension's own control, so its popup opens
// from there. True when an enabled extension bound the key.
bool DispatchExtensionShortcut(LinuxWindow& window, const input::NativeWebKeyboardEvent& event);

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_EXTENSIONS_LINUX_H_
