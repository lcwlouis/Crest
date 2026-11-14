#ifndef CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
#define CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_

// A Crest window on Linux: Crest's sidebar, drawn by the chrome://crest WebUI,
// beside the page the window shows. Chromium draws both, so the same window
// serves Fedora and Windows. The Mac's SwiftUI window hosts each page's view
// the same way, asking the shell for it by the page's id.

#include <memory>
#include <string>

#include "base/memory/raw_ptr.h"
#include "ui/views/widget/widget_delegate.h"

class Profile;
namespace views { class WebView; class Widget; }

namespace crest {

class LinuxWindow final {
 public:
  // Opens a window whose sidebar runs in `profile`, Crest's bootstrap
  // profile. The window lives until the person closes it.
  static LinuxWindow* Open(Profile* profile);
  // The window, or null before one opens and once it closes.
  static LinuxWindow* Current();

  LinuxWindow(const LinuxWindow&) = delete;
  LinuxWindow& operator=(const LinuxWindow&) = delete;
  ~LinuxWindow();

  views::Widget* widget() const { return widget_.get(); }

  // Shows the page `page` (a core page id) beside the sidebar. False when the
  // engine has no such page.
  bool ShowPage(const std::string& page);
  // The engine let `page` go; the window stops showing it.
  void ReleasePage(const std::string& page);

 private:
  explicit LinuxWindow(Profile* profile);

  // The person closed the window.
  void Closing();

  // The window owns its widget and the widget's delegate.
  views::WidgetDelegate delegate_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<views::WebView> sidebar_ = nullptr;
  raw_ptr<views::WebView> page_ = nullptr;
  std::string shown_page_;
};

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_LINUX_WINDOW_H_
