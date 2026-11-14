#include "chrome/browser/ui/crest/crest_linux_window.h"

#include <memory>

#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_webui_linux.h"
#include "content/public/browser/web_contents.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace crest {

namespace {

// The sidebar's width until Crest's own sidebar sizing reaches Linux.
constexpr int kSidebarWidth = 280;

LinuxWindow* g_window = nullptr;

}  // namespace

// static
LinuxWindow* LinuxWindow::Open(Profile* profile) {
  CHECK(!g_window);
  auto* window = new LinuxWindow(profile);
  views::Widget::InitParams params(views::Widget::InitParams::NATIVE_WIDGET_OWNS_WIDGET,
                                   views::Widget::InitParams::TYPE_WINDOW);
  params.delegate = window;
  params.bounds = gfx::Rect(80, 80, 1280, 820);
  params.wm_class_name = "crest";
  params.wm_class_class = "Crest";
  params.name = "CrestWindow";
  auto* widget = new views::Widget();
  widget->Init(std::move(params));
  widget->Show();
  return window;
}

// static
LinuxWindow* LinuxWindow::Current() {
  return g_window;
}

LinuxWindow::LinuxWindow(Profile* profile) {
  g_window = this;
  SetOwnedByWidget(OwnedByWidgetPassKey());
  SetTitle(u"Crest");
  SetCanResize(true);
  SetCanMaximize(true);
  SetCanMinimize(true);

  auto* layout = SetLayoutManager(std::make_unique<views::BoxLayout>(views::BoxLayout::Orientation::kHorizontal));
  auto sidebar = std::make_unique<views::WebView>(profile);
  sidebar->SetPreferredSize(gfx::Size(kSidebarWidth, 0));
  sidebar_ = AddChildView(std::move(sidebar));
  page_ = AddChildView(std::make_unique<views::WebView>(profile));
  layout->SetFlexForView(page_, 1);
  sidebar_->LoadInitialURL(GURL(kCrestUIURL));
}

LinuxWindow::~LinuxWindow() {
  if (g_window == this) g_window = nullptr;
}

bool LinuxWindow::ShowPage(const std::string& page) {
  EnginePage* engine_page = EngineBinding::Get().Find(page);
  content::WebContents* contents = engine_page ? engine_page->web_contents() : nullptr;
  if (!contents) return false;
  shown_page_ = page;
  page_->SetWebContents(contents);
  contents->Focus();
  return true;
}

void LinuxWindow::ReleasePage(const std::string& page) {
  if (page != shown_page_) return;
  shown_page_.clear();
  page_->SetWebContents(nullptr);
}

void LinuxWindow::WindowClosing() {
  // The window does not own the pages it shows; it lets go before they go.
  page_->SetWebContents(nullptr);
  shown_page_.clear();
  CrestWindowClosed();
}

}  // namespace crest
