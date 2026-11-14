#ifndef CHROME_BROWSER_UI_CREST_CREST_WEBUI_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_WEBUI_LINUX_H_

// chrome://crest: Crest's own UI on Linux, drawn by Chromium. The page speaks
// the core's wire format: it receives every batch of changes the core
// publishes and every page presentation, and sends intents, queries and page
// requests back, each as base64 of the encoded message. The page's files
// come from the directory Crest's UI build writes (`--crest-ui-dir`, or
// `crest_ui` beside the browser), so the UI changes without a Chromium build.

#include <string>

#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

namespace input {
struct NativeWebKeyboardEvent;
}

namespace crest {

inline constexpr char kCrestUIHost[] = "crest";
inline constexpr char kCrestUIURL[] = "chrome://crest/";

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

// Takes a key a page's view received when it is one of Crest's shortcuts the
// WebUI registered: the ones Crest reserves from pages before the page sees
// them, and the rest once the page declined them. The WebUI then performs it.
bool ClaimShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined);

// Asks the WebUI to perform one of its commands (a ShortcutCommand name), as
// Chromium's own browser window asks for the location field.
void PerformCommand(const std::string& command);

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_WEBUI_LINUX_H_
