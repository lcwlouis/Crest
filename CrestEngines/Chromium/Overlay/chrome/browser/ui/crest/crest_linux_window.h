#ifndef CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
#define CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_

// A Crest window on Linux: the chrome://crest WebUI draws the whole window,
// Crest's sidebar, toolbar and everything around the page, and the page the
// window shows sits over it, where the WebUI says the page goes. Chromium
// draws both, so the same window serves Fedora and Windows. The Mac's SwiftUI
// window hosts each page's view the same way, asking the shell for it by the
// page's id.

#include <memory>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/scoped_observation.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/widget/widget_observer.h"

class Profile;
namespace views { class WebView; class Widget; }

namespace crest {

class LinuxWindow final : public views::WidgetObserver {
 public:
  // Opens a window whose sidebar runs in `profile`, Crest's bootstrap
  // profile. The window lives until the person closes it.
  static LinuxWindow* Open(Profile* profile);
  // The window, or null before one opens and once it closes.
  static LinuxWindow* Current();

  LinuxWindow(const LinuxWindow&) = delete;
  LinuxWindow& operator=(const LinuxWindow&) = delete;
  ~LinuxWindow() override;

  // `bounds`, in screen coordinates, moved onto the work area of the display
  // it is most on, and shrunk to fit it, as the Mac keeps a window it
  // restores or moves on a screen.
  static gfx::Rect OnScreen(const gfx::Rect& bounds);

  views::Widget* widget() const { return widget_.get(); }

  // Shows the page `page` (a core page id) beside the sidebar. False when the
  // engine has no such page.
  bool ShowPage(const std::string& page);
  // Shows no page: the WebUI draws the page's card itself.
  void ShowNoPage();
  // The engine let `page` go; the window stops showing it.
  void ReleasePage(const std::string& page);
  // Where the page goes, in the WebUI's coordinates, which are the window
  // contents' (the WebUI fills them at its natural zoom).
  void SetPageBounds(const gfx::Rect& bounds);
  // Raises the WebUI over the page while it draws a floating surface (the
  // command bar, a menu, Peek), and lowers it again after. Raised, the WebUI
  // is transparent where the page shows through and takes the input.
  void SetOverlay(bool raised);
  // Places the floating surface the WebUI draws over the page (the find bar,
  // a notice), in the window contents' coordinates; empty hides it. `focus`
  // gives it the keyboard.
  void SetFloat(const gfx::Rect& bounds, bool focus);

 private:
  explicit LinuxWindow(Profile* profile);

  // The person closed the window.
  void Closing();

  // views::WidgetObserver: a window the window manager placed off every
  // display (Mutter under XWayland can put a new one below the screen) comes
  // back onto one.
  void OnWidgetBoundsChanged(views::Widget* widget, const gfx::Rect& new_bounds) override;

  // What the engine's browser window asks of Crest's UI, which the WebUI
  // answers where it can.
  class UI final : public LinuxUI {
   public:
    gfx::Rect RestoredBounds(views::Widget* window) override;
    bool WasMaximizedBeforeFullscreen(views::Widget* window) override;
    bool DeferQuit() override;
    bool Reopen() override;
    bool HandleShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined) override;
    void FocusLocation() override;
    void BookmarkActivePage() override;
    void TranslatePage() override;
    void TranslateText(const std::u16string& text) override;
    void ShowTabSearch() override;
    void ShowUnavailable(UnavailableFeature feature) override;
    void ShowEngineNotice(const std::u16string& message, EngineNoticeKind kind) override;
  };
  UI ui_shell_;

  // The window owns its widget and the widget's delegate.
  views::WidgetDelegate delegate_;
  std::unique_ptr<views::Widget> widget_;
  base::ScopedObservation<views::Widget, views::WidgetObserver> placement_{this};
  raw_ptr<views::WebView> ui_ = nullptr;
  raw_ptr<views::WebView> page_ = nullptr;
  raw_ptr<views::WebView> float_ = nullptr;
  std::string shown_page_;
  bool overlay_raised_ = false;
  bool float_focused_ = false;
};

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
