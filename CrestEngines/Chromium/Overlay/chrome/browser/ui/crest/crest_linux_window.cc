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
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/skia/include/core/SkColor.h"
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
  SetLinuxUI(&ui_shell_);
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
  if (GetLinuxUI() == &ui_shell_) SetLinuxUI(nullptr);
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

void LinuxWindow::SetOverlay(bool raised) {
  if (raised == overlay_raised_) return;
  overlay_raised_ = raised;
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  // The WebUI paints its own backdrop; where it paints nothing, raised, the
  // page under it shows through.
  content::WebContents* ui_contents = ui_->web_contents();
  if (content::RenderWidgetHostView* view = ui_contents ? ui_contents->GetRenderWidgetHostView() : nullptr) {
    view->SetBackgroundColor(SK_ColorTRANSPARENT);
  }
  // The views' order is the native windows' order: the last child draws on
  // top and takes the pointer.
  contents->ReorderChildView(ui_, raised ? contents->children().size() : 0);
  widget_->ReorderNativeViews();
  if (raised) {
    ui_->RequestFocus();
  } else if (page_->web_contents()) {
    page_->RequestFocus();
  }
}

void LinuxWindow::Closing() {
  // The window does not own the pages it shows; it lets go before they go.
  page_->SetWebContents(nullptr);
  shown_page_.clear();
  g_window = nullptr;
  if (GetLinuxUI() == &ui_shell_) SetLinuxUI(nullptr);
  // The widget is still closing on this stack; it goes once that returns.
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
  CrestWindowClosed();
}

gfx::Rect LinuxWindow::UI::RestoredBounds(views::Widget* window) {
  return window->GetRestoredBounds();
}

// TODO(linux): remember whether the window was maximized when it entered
// fullscreen, as the Mac's shell does.
bool LinuxWindow::UI::WasMaximizedBeforeFullscreen(views::Widget* window) {
  return false;
}

// TODO(linux): Crest's quit preparation (downloads, unsaved pages) asks
// through Crest's own dialogs, which the Linux WebUI does not draw yet.
bool LinuxWindow::UI::DeferQuit() {
  return false;
}

bool LinuxWindow::UI::Reopen() {
  return false;
}

bool LinuxWindow::UI::HandleShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined) {
  return ClaimShortcut(event, page_declined);
}

void LinuxWindow::UI::FocusLocation() {
  PerformCommand("OpenLocation");
}

// TODO(linux): the rest arrive with the WebUI surfaces that answer them.
void LinuxWindow::UI::BookmarkActivePage() {}
void LinuxWindow::UI::TranslatePage() {}
void LinuxWindow::UI::TranslateText(const std::u16string& text) {}
void LinuxWindow::UI::ShowTabSearch() {
  PerformCommand("NewTab");
}
void LinuxWindow::UI::ShowUnavailable(UnavailableFeature feature) {}
void LinuxWindow::UI::ShowEngineNotice(const std::u16string& message, EngineNoticeKind kind) {}

}  // namespace crest
