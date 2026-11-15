#ifndef CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
#define CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_

// A Crest window on Linux: the chrome://crest WebUI draws the whole window,
// Crest's sidebar, toolbar and everything around the pages, and the pages the
// window shows sit over it, where the WebUI says each goes: one page, the
// cards of a split side by side, and a Peek's page over them. Chromium draws
// both, so the same window serves Fedora and Windows. The Mac's SwiftUI
// window hosts each page's view the same way, asking the shell for it by the
// page's id.

#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/scoped_observation.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "content/public/browser/web_contents_observer.h"
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

  // One page the window shows and where: a core page id, its place in the
  // WebUI's coordinates, which are the window contents' (the WebUI fills them
  // at its natural zoom), and the radius of its corners. A page `above` stays
  // over the WebUI while the WebUI is raised, as a Peek's page stays over the
  // ground the WebUI dims around it.
  struct PageSlot {
    std::string page;
    gfx::Rect bounds;
    bool above = false;
    float corner_radius = 0;
  };

  // Shows `slots`, the later ones over the earlier, and no other page. The
  // page `focused` names is the one in use, which takes the keyboard and
  // which extensions find as the active tab; empty when none is. Pages the
  // engine does not have are left out.
  void SetPageLayout(const std::vector<PageSlot>& slots, const std::string& focused);
  // Shows the page `page` (a core page id) alone, where SetPageBounds last
  // placed it. False when the engine has no such page.
  bool ShowPage(const std::string& page);
  // Shows no page: the WebUI draws the page's card itself.
  void ShowNoPage();
  // The engine let `page` go; the window stops showing it.
  void ReleasePage(const std::string& page);
  // Where ShowPage places its page, in the WebUI's coordinates.
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

  // Hears the person click into a page the window shows.
  class FocusObserver;

  // One view that shows a page, or none while it waits for one.
  struct Slot {
    raw_ptr<views::WebView> view;
    std::string page;
    bool above = false;
    float corner_radius = 0;
    // Hears the person click into the page.
    std::unique_ptr<FocusObserver> focus;
  };

  // The person closed the window.
  void Closing();
  // Shows `page` in the view of `slot`, which shows nothing.
  void Attach(Slot& slot, const std::string& page, content::WebContents* contents);
  // Lets the view of `slot` go of its page.
  void Detach(Slot& slot);
  // The slot showing `page`, or null.
  Slot* SlotShowing(const std::string& page);
  // Stacks the views: the WebUI under the pages, or raised over all but the
  // pages above it, and the floating surface over everything.
  void Restack();
  // Gives the keyboard to the page in use, or to the WebUI while it is raised
  // over that page.
  void FocusInUse();
  // The person clicked into `page`'s view.
  void PageFocused(const std::string& page);

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
  raw_ptr<Profile> profile_;
  raw_ptr<views::WebView> ui_ = nullptr;
  raw_ptr<views::WebView> float_ = nullptr;
  // The views that show pages, in the order they stack, those showing none
  // last; they are made as the layout needs them and kept.
  std::vector<Slot> slots_;
  // The page in use, among those shown.
  std::string focused_page_;
  // Where ShowPage places its page, and whether the window shows that one
  // page rather than a layout the WebUI gave.
  gfx::Rect single_bounds_;
  bool single_ = false;
  bool overlay_raised_ = false;
  bool float_focused_ = false;
};

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
