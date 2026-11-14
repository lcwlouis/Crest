#include "chrome/browser/ui/crest/crest_linux_window.h"

#include <memory>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_webui_linux.h"
#include "content/public/browser/web_contents.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace crest {

namespace {

LinuxWindow* g_window = nullptr;

// The page's corners, BrowserChromeLayout.pageCornerRadius on the Mac.
constexpr float kPageCornerRadius = 13;

// The window's contents: the WebUI fills them, and the page sits over it in
// the bounds the WebUI last named, which the WebUI lays out again on resize.
class Contents final : public views::View {
 public:
  raw_ptr<views::WebView> ui = nullptr;
  raw_ptr<views::WebView> page = nullptr;
  gfx::Rect page_bounds;

  void Layout(PassKey) override {
    if (ui) ui->SetBoundsRect(GetLocalBounds());
    if (page) {
      gfx::Rect bounds = page_bounds;
      bounds.Intersect(GetLocalBounds());
      page->SetBoundsRect(bounds);
    }
  }
};

}  // namespace

// static
LinuxWindow* LinuxWindow::Open(Profile* profile) {
  CHECK(!g_window);
  return new LinuxWindow(profile);
}

// static
LinuxWindow* LinuxWindow::Current() {
  return g_window;
}

LinuxWindow::LinuxWindow(Profile* profile) {
  g_window = this;
  delegate_.SetTitle(u"Crest");
  delegate_.SetHasWindowSizeControls(true);
  delegate_.RegisterWindowClosingCallback(base::BindOnce(&LinuxWindow::Closing, base::Unretained(this)));

  auto contents = std::make_unique<Contents>();
  contents->ui = contents->AddChildView(std::make_unique<views::WebView>(profile));
  // Added after the WebUI, so it draws over it.
  contents->page = contents->AddChildView(std::make_unique<views::WebView>(profile));
  ui_ = contents->ui;
  page_ = contents->page;
  delegate_.SetContentsView(std::move(contents));

  widget_ = std::make_unique<views::Widget>();
  views::Widget::InitParams params(views::Widget::InitParams::CLIENT_OWNS_WIDGET,
                                   views::Widget::InitParams::TYPE_WINDOW);
  params.delegate = &delegate_;
  params.bounds = gfx::Rect(80, 80, 1280, 820);
  params.wm_class_name = "crest";
  params.wm_class_class = "Crest";
  params.name = "CrestWindow";
  widget_->Init(std::move(params));
  ui_->LoadInitialURL(GURL(kCrestUIURL));
  widget_->Show();
}

LinuxWindow::~LinuxWindow() {
  // The widget goes before the delegate it holds.
  widget_.reset();
  if (g_window == this) g_window = nullptr;
}

// The page is shown as the Mac shows one: the engine's ShowPage makes its
// WebContents visible and the active tab of the Browser that keeps it, and the
// page it replaces is hidden.
bool LinuxWindow::ShowPage(const std::string& page) {
  EngineBinding& binding = EngineBinding::Get();
  EnginePage* engine_page = binding.Find(page);
  content::WebContents* contents = engine_page ? engine_page->web_contents() : nullptr;
  if (!contents) return false;
  if (page == shown_page_ && page_->web_contents() == contents) return true;
  if (EnginePage* hidden = shown_page_.empty() ? nullptr : binding.Find(shown_page_)) {
    hidden->Answer(engine::HidePage{.page_id = hidden->id()});
  }
  shown_page_ = page;
  page_->SetWebContents(contents);
  // The mask goes with the native view, so each page attached takes it.
  page_->holder()->SetNativeViewCornerRadii(gfx::RoundedCornersF(kPageCornerRadius));
  return engine_page->Answer(engine::ShowPage{.page_id = engine_page->id()});
}

void LinuxWindow::ReleasePage(const std::string& page) {
  if (page != shown_page_) return;
  shown_page_.clear();
  page_->SetWebContents(nullptr);
}

void LinuxWindow::SetPageBounds(const gfx::Rect& bounds) {
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  if (contents->page_bounds == bounds) return;
  contents->page_bounds = bounds;
  contents->InvalidateLayout();
}

void LinuxWindow::Closing() {
  // The window does not own the pages it shows; it lets go before they go.
  page_->SetWebContents(nullptr);
  shown_page_.clear();
  g_window = nullptr;
  // The widget is still closing on this stack; it goes once that returns.
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
  CrestWindowClosed();
}

}  // namespace crest
