#ifndef CHROME_BROWSER_UI_CREST_CREST_WEBUI_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_WEBUI_LINUX_H_

// chrome://crest: Crest's own UI on Linux, drawn by Chromium. The page speaks
// the core's wire format: it receives every batch of changes the core
// publishes and every page presentation, and sends intents, queries and page
// requests back, each as base64 of the encoded message. The page's files
// come from the directory Crest's UI build writes (`--crest-ui-dir`, or
// `crest_ui` beside the browser), so the UI changes without a Chromium build.

#include <string>
#include <vector>

#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

class GURL;

namespace input {
struct NativeWebKeyboardEvent;
}

namespace crest {

class LinuxWindow;

inline constexpr char kCrestUIHost[] = "crest";
inline constexpr char kCrestUIURL[] = "chrome://crest/";
// The page of the small surfaces that float over a page (find bar, notices).
inline constexpr char kCrestFloatURL[] = "chrome://crest/float.html";

class CrestUI;

class CrestUIConfig final : public content::DefaultWebUIConfig<CrestUI> {
 public:
  CrestUIConfig();
};

class CrestUI final : public content::WebUIController {
 public:
  explicit CrestUI(content::WebUI* web_ui);
  CrestUI(const CrestUI&) = delete;
  CrestUI& operator=(const CrestUI&) = delete;
  ~CrestUI() override;
};

// Adds chrome://crest to the WebUI configs, once.
void RegisterCrestUI();

// Each window's WebUI hears what concerns its own window.

// Takes a key a page's view in `window` received when it is one of Crest's
// shortcuts the window's WebUI registered: the ones Crest reserves from pages
// before the page sees them, and the rest once the page declined them. The
// WebUI then performs it.
bool ClaimShortcut(LinuxWindow& window, const input::NativeWebKeyboardEvent& event, bool page_declined);

// Asks the window's WebUI to perform one of its commands (a ShortcutCommand
// name), as Chromium's own browser window asks for the location field.
void PerformCommand(LinuxWindow& window, const std::string& command);

// The name of the search engine a selection on `page` (a binding key) searches
// with, which the WebUI names for the page the window shows; empty for any
// other page, which offers no search.
std::u16string SelectionSearchEngine(const std::string& page);

// Asks the WebUI of the window showing `page`, or of the window in use, to
// search for `text` from `page` in a new tab of the page's
// Space, as the Mac's page menu does. False when no WebUI listens.
bool SearchSelection(const std::string& page, const std::u16string& text);

// Asks the WebUI of the window showing `page` (a binding key), or of the
// window in use, for the core's clean copy of `url` (LinkToCopy), which the
// WebUI hands back to go on the clipboard. False when no WebUI listens.
bool CopyLink(const std::string& page, const GURL& url);

// Tells the WebUI the person clicked into the view of `page`, a core page id
// the window shows, so it can make that split card the one in use.
void ReportPageFocused(LinuxWindow& window, const std::string& page);

// Tells the WebUI another window shows `page` now, so this one no longer can.
void ReportPageLeft(LinuxWindow& window, const std::string& page);

// Tells the WebUI the window shows `page`, which the engine keeps for another
// window, so it moves the page to its own.
void ReportPageArrived(LinuxWindow& window, const std::string& page);

// Tells the WebUI the window came into use, or left it.
void ReportWindowActive(LinuxWindow& window, bool active);

// Asks the WebUI whether the window may close, as the person asked; `last`
// when it is the last browser window, whose close quits. False when no WebUI
// can answer, and the window closes at once.
bool AskToClose(LinuxWindow& window, bool last);

// Asks a browser window's WebUI to show the Space `space`, a core id, as an
// engine window the core placed there opens.
void ShowSpace(LinuxWindow& window, const std::string& space);

// Hands the WebUI of `window` links another app opened, for the core to
// route. False when it cannot take them yet.
bool OpenExternalLinks(LinuxWindow& window, const std::vector<std::string>& urls);

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_WEBUI_LINUX_H_
