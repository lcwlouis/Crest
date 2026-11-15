#ifndef CHROME_BROWSER_UI_CREST_CREST_LINUX_UI_H_
#define CHROME_BROWSER_UI_CREST_CREST_LINUX_UI_H_

// Crest's own UI on Linux, which the Linux shell asks on the UI thread for
// what only Crest's windows can answer. It mirrors the Mac shell's
// `CrestMacUI` protocol (CrestEngines/Chromium/Apple/CrestChromiumHost.h) one
// call for one call, so the browser window and the hooks keep the same shape
// on both platforms. Crest's Chromium-drawn shell attaches it when it starts;
// before that every call has a quiet default.

#include <string>
#include <vector>

#include "ui/gfx/geometry/rect.h"

class Browser;
namespace input { struct NativeWebKeyboardEvent; }
namespace views { class Widget; }

namespace crest {

// A Chromium feature whose own UI this build never shows. Crest says so in a
// notice instead, in its own words. Same order as CrestUnavailableFeature.
enum class UnavailableFeature {
  kAutofill,
  kAddressAutofill,
  kAddressAutofillSignIn,
  kAutofillAI,
  kAutofillOffers,
  kAutofillReauthentication,
  kPaymentAutofill,
  kVirtualCardEnrollment,
  kProfiles,
  kEyeDropper,
  kCaretBrowsing,
  kPrivateBrowsing,
  kChromeLabs,
};

// What one of Chromium's own toasts is about. Same order as
// CrestEngineNoticeKind.
enum class EngineNoticeKind {
  kLinkCopied,
  kConfirmation,
};

class LinuxUI {
 public:
  virtual ~LinuxUI() = default;
  // The shell keeps the bounds a maximized or fullscreen window returns to.
  virtual gfx::Rect RestoredBounds(views::Widget* window) = 0;
  virtual bool WasMaximizedBeforeFullscreen(views::Widget* window) = 0;
  // A quit the application asked for; true while Crest finishes it itself.
  virtual bool DeferQuit() = 0;
  // A launch or activation with no Crest window.
  virtual bool Reopen() = 0;
  // What the engine's browser window asks of Crest's: a shortcut, before the
  // page sees it or once the page declined it, the location field, a bookmark
  // for the active page, translation and tab search.
  virtual bool HandleShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined) = 0;
  virtual void FocusLocation() = 0;
  virtual void BookmarkActivePage() = 0;
  virtual void TranslatePage() = 0;
  virtual void TranslateText(const std::u16string& text) = 0;
  virtual void ShowTabSearch() = 0;
  virtual void ShowUnavailable(UnavailableFeature feature) = 0;
  virtual void ShowEngineNotice(const std::u16string& message,
                                EngineNoticeKind kind) = 0;
};

// Crest's UI once it has started; null before.
LinuxUI* GetLinuxUI();
void SetLinuxUI(LinuxUI* ui);

// The Crest window `browser` shows in: the one the core window it is kept
// for draws, or for a Browser kept for none, the window in use; null before
// Crest's UI places it and once that window closed.
views::Widget* WindowForBrowser(const Browser* browser);

// One of Crest's windows closed. Once no browser window is left, Crest closes
// the rest, lets its pages go, closes its core and quits, as a quit from the
// Mac's application menu does.
void CrestWindowClosed();

// A window's WebUI opened the core's window `window` (in GuidText's
// spelling) for it: the tabs the engine opened for that window are offered.
void WindowAdopted(const std::string& window);

// Links another app handed Crest, as a second launch passes them: the WebUI
// of the window in use asks the core where each goes, and opens it there or
// in a Quick Window. False before a WebUI can take them.
bool OpenExternalURLs(const std::vector<std::string>& urls);

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_LINUX_UI_H_
