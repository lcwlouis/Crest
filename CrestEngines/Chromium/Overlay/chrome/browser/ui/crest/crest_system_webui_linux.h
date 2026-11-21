#ifndef CHROME_BROWSER_UI_CREST_CREST_SYSTEM_WEBUI_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_SYSTEM_WEBUI_LINUX_H_

// What chrome://crest asks of the desktop and of a window's page cards
// beyond the core: the inspector docked in a card, the desktop's
// notifications, the desktop's screen-sharing picker, and a page's print
// preview, the save dialog for what a page exported and the clipboard for a
// capture of it. It lives beside
// crest_webui_linux.cc's handler, which relays the core, as its own message
// handler on the same page.

#include <memory>

namespace content {
class WebUIMessageHandler;
}

namespace crest {

// The handler chrome://crest's main page adds for these messages.
std::unique_ptr<content::WebUIMessageHandler> CreateSystemUIHandler();

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_SYSTEM_WEBUI_LINUX_H_
