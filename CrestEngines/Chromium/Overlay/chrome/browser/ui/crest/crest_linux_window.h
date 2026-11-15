#ifndef CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
#define CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_

// A Crest window on Linux: the chrome://crest WebUI draws the whole window,
// Crest's sidebar, toolbar and everything around the pages, and the pages the
// window shows sit over it, where the WebUI says each goes: one page, the
// cards of a split side by side, and a Peek's page over them. Chromium draws
// both, so the same window serves Fedora and Windows. The Mac's SwiftUI
// window hosts each page's view the same way, asking the shell for it by the
// page's id.
//
// Crest opens as many windows as the person asks for, as the Mac's
// BrowserMacWindows does: browser windows, each over a window the core keeps
// under its own identity, and Quick Windows, which show one transient page of
// a Space. Each window's WebUI decides what it shows through the core; the
// window knows only the core's identity for it, which the engine's Browsers
// are kept by, and the order the person last used the windows in.

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/scoped_observation.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/widget/widget_observer.h"

class Profile;
namespace base { class FilePath; }
namespace content { class WebContents; }
namespace views { class WebView; }

namespace crest {

class LinuxWindow final : public views::WidgetObserver {
 public:
  // A kind of window Crest opens: the WebUI page that draws it, the size it
  // opens at and the smallest it may be, as the Mac's BrowserMacWindowKind,
  // and whether it browses the person's Spaces as a window the core keeps.
  struct Kind {
    // Its name, as the WebUI asks for it.
    const char* name;
    // The page of chrome://crest that draws it.
    const char* page;
    gfx::Size size;
    gfx::Size minimum;
    bool browses;

    // A browser window over the person's Spaces.
    static const Kind kBrowser;
    // A Quick Window, which shows one page of a Space
    // (BrowserQuickWindowLayout).
    static const Kind kQuick;

    // The kind `name` names, or null.
    static const Kind* Named(std::string_view name);
  };

  // Opens a window of `kind` whose WebUI runs in `profile`, Crest's bootstrap
  // profile, and reads `query`, the WebUI's own parameters, in its address.
  // `id` is the core's identity for a browser window, or empty until its
  // WebUI adopts one, as the launch's first window does. The window comes
  // forward when `activates`, and otherwise shows behind the window in use.
  // It lives until it closes.
  static LinuxWindow* Open(Profile* profile, const Kind& kind, const std::string& id, const std::string& query,
                           bool activates);
  // The open window the core names `id`, or null.
  static LinuxWindow* Find(const std::string& id);
  // The window the person is using: the active one, or else the one used
  // last; null when none is open.
  static LinuxWindow* Active();
  // The window whose WebUI or floating surfaces `contents` draws, or null.
  static LinuxWindow* Drawing(const content::WebContents* contents);
  // The core's identities of the open browser windows, the one used last
  // first, as the Mac's stackedWindowIDs lists them front to back. Linux
  // cannot ask the window manager how it stacks them.
  static std::vector<std::string> Stacked();
  // Whether a browser window is open.
  static bool AnyBrowsing();
  // Closes every window without asking its WebUI, as a quit does.
  static void CloseAll();
  // Stops showing `page` in any window: the engine lets it go.
  static void ReleaseEverywhere(const std::string& page);
  // Reads the frames the browser windows kept under their ids from `file`,
  // as the Mac's windows keep theirs under their autosave names, and keeps
  // each window's there from now on. A window with an id takes its own once
  // they are read.
  static void LoadFrames(const base::FilePath& file);

  LinuxWindow(const LinuxWindow&) = delete;
  LinuxWindow& operator=(const LinuxWindow&) = delete;
  ~LinuxWindow() override;

  // `bounds`, in screen coordinates, moved onto the work area of the display
  // it is most on, and shrunk to fit it, as the Mac keeps a window it
  // restores or moves on a screen.
  static gfx::Rect OnScreen(const gfx::Rect& bounds);

  views::Widget* widget() const { return widget_.get(); }
  const Kind& kind() const { return kind_; }
  // The core's identity for the window, in GuidText's spelling; empty for a
  // Quick Window and until the WebUI adopts one.
  const std::string& id() const { return id_; }
  // The WebUI opened the core's window `id` for this one, which places it at
  // the frame that window kept.
  void Adopt(const std::string& id);
  content::WebContents* ui_contents() const;
  content::WebContents* float_contents() const;

  // Brings the window forward and gives it the keyboard.
  void Present();
  // Closes the window without asking the WebUI again: it agreed, or the
  // window has nothing left to ask.
  void Close();
  // Names the window for the window manager and the desktop's window list.
  void SetTitle(const std::u16string& title);

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
  // engine does not have are left out. A page another window shows moves to
  // this one, which tells that window's WebUI it left.
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
  LinuxWindow(Profile* profile, const Kind& kind, std::string id);

  // Asks the WebUI before the window closes, as the Mac's close gate asks
  // before a window goes.
  class Delegate final : public views::WidgetDelegate {
   public:
    explicit Delegate(LinuxWindow& window) : window_(window) {}
    // views::WidgetDelegate:
    bool OnCloseRequested(views::Widget::ClosedReason reason) override;

   private:
    LinuxWindow& window_;
  };

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

  // views::WidgetObserver:
  void OnWidgetActivationChanged(views::Widget* widget, bool active) override;

  // Places a browser window at the frame its id kept, once the frames are
  // read, and keeps its frame under its id after that.
  void RestoreFrame();
  void RememberFrame();

  // The window is closing.
  void Closing();
  // Another window shows `page` now; this one stops showing it.
  void Surrender(const std::string& page);
  // Shows `page` in the view of `slot`, which shows nothing.
  void Attach(Slot& slot, const std::string& page, content::WebContents* contents);
  // Lets the view of `slot` go of its page.
  void Detach(Slot& slot);
  // The slot showing `page`, or null.
  Slot* SlotShowing(const std::string& page);
  // Whether the window shows `contents` in one of its slots.
  bool Shows(const content::WebContents* contents) const;
  // Stacks the views: the WebUI under the pages, or raised over all but the
  // pages above it, and the floating surface over everything.
  void Restack();
  // Gives the keyboard to the page in use, or to the WebUI while it is raised
  // over that page.
  void FocusInUse();
  // The person clicked into `page`'s view.
  void PageFocused(const std::string& page);

  // views::WidgetObserver: the window keeps its frame, and a window the
  // window manager placed off every display (Mutter under XWayland can put a
  // new one below the screen) comes back onto one.
  void OnWidgetBoundsChanged(views::Widget* widget, const gfx::Rect& new_bounds) override;

  // What the engine's browser window asks of Crest's UI, which the WebUI of
  // the window in use answers where it can.
  class UI final : public LinuxUI {
   public:
    explicit UI(LinuxWindow& window) : window_(window) {}

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

   private:
    LinuxWindow& window_;
  };
  UI ui_shell_{*this};

  const Kind& kind_;
  std::string id_;
  // The window owns its widget and the widget's delegate.
  Delegate delegate_{*this};
  std::unique_ptr<views::Widget> widget_;
  // The widget's activation and placement, which the window follows.
  base::ScopedObservation<views::Widget, views::WidgetObserver> observation_{this};
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
  // When the person last used the window, in the order of every window's use.
  uint64_t used_ = 0;
  // Whether the window took the frame its id kept, or found none, so its own
  // frame is the one to keep.
  bool frame_restored_ = false;
  // The WebUI agreed to the window closing, or there is nothing to ask.
  bool closes_ = false;
};

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
