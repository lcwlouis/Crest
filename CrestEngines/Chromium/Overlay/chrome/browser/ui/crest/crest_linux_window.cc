#include "chrome/browser/ui/crest/crest_linux_window.h"

#include <algorithm>
#include <memory>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/location.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_webui_linux.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
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

// The window's contents: the WebUI fills them, and each page sits over it in
// the bounds the WebUI last named, which the WebUI lays out again on resize.
class Contents final : public views::View {
 public:
  raw_ptr<views::WebView> ui = nullptr;
  raw_ptr<views::WebView> floating = nullptr;
  // Each page view and where it goes; a view showing no page is hidden.
  std::vector<std::pair<raw_ptr<views::WebView>, gfx::Rect>> pages;
  gfx::Rect float_bounds;

  void Layout(PassKey) override {
    if (ui) ui->SetBoundsRect(GetLocalBounds());
    for (auto& [view, page_bounds] : pages) {
      gfx::Rect bounds = page_bounds;
      bounds.Intersect(GetLocalBounds());
      view->SetBoundsRect(bounds);
    }
    PlaceFloating();
  }

  // Placed at once rather than at the next layout: a hidden view cannot take
  // the keyboard, so the surface must show before it is focused.
  void PlaceFloating() {
    if (!floating) return;
    gfx::Rect bounds = float_bounds;
    bounds.Intersect(GetLocalBounds());
    floating->SetBoundsRect(bounds);
    floating->SetVisible(!bounds.IsEmpty());
  }
};

}  // namespace

// Tells the window when the person clicks into a page it shows, as the Mac's
// split surface hears a mouse-down in one of its cards.
class LinuxWindow::FocusObserver final : public content::WebContentsObserver {
 public:
  FocusObserver(content::WebContents* contents, base::RepeatingClosure focused)
      : content::WebContentsObserver(contents), focused_(std::move(focused)) {}

  // content::WebContentsObserver:
  void OnWebContentsFocused(content::RenderWidgetHost*) override { focused_.Run(); }

 private:
  base::RepeatingClosure focused_;
};

// static
LinuxWindow* LinuxWindow::Open(Profile* profile) {
  CHECK(!g_window);
  return new LinuxWindow(profile);
}

// static
LinuxWindow* LinuxWindow::Current() {
  return g_window;
}

LinuxWindow::LinuxWindow(Profile* profile) : profile_(profile) {
  g_window = this;
  SetLinuxUI(&ui_shell_);
  delegate_.SetTitle(u"Crest");
  delegate_.SetHasWindowSizeControls(true);
  delegate_.RegisterWindowClosingCallback(base::BindOnce(&LinuxWindow::Closing, base::Unretained(this)));

  auto contents = std::make_unique<Contents>();
  contents->ui = contents->AddChildView(std::make_unique<views::WebView>(profile));
  // Over the pages, which come between the two as the layout asks for them:
  // the small surfaces that float on a page while it stays in use (the find
  // bar, notices), which the WebUI places and fills.
  contents->floating = contents->AddChildView(std::make_unique<views::WebView>(profile));
  contents->floating->SetVisible(false);
  ui_ = contents->ui;
  float_ = contents->floating;
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
  float_->LoadInitialURL(GURL(kCrestFloatURL));
  widget_->Show();
}

LinuxWindow::~LinuxWindow() {
  if (GetLinuxUI() == &ui_shell_) SetLinuxUI(nullptr);
  // The pages' observers and views are let go before the widget that owns
  // the views.
  slots_.clear();
  // The widget goes before the delegate it holds.
  widget_.reset();
  if (g_window == this) g_window = nullptr;
}

// The pages are shown as the Mac shows them: the engine's ShowPage makes a
// page's WebContents visible and the active tab of the Browser that keeps it,
// and a page that leaves is hidden. The page in use is shown last, so it is
// the active tab and holds the keyboard.
void LinuxWindow::SetPageLayout(const std::vector<PageSlot>& layout, const std::string& focused) {
  single_ = false;
  EngineBinding& binding = EngineBinding::Get();
  // Only pages the engine has, each once.
  std::vector<PageSlot> wanted;
  for (const PageSlot& place : layout) {
    EnginePage* page = binding.Find(place.page);
    if (!page || !page->web_contents()) continue;
    if (std::ranges::any_of(wanted, [&](const PageSlot& held) { return held.page == place.page; })) continue;
    wanted.push_back(place);
  }
  const auto is_wanted = [&](const std::string& page) {
    return std::ranges::any_of(wanted, [&](const PageSlot& place) { return place.page == page; });
  };
  for (Slot& slot : slots_) {
    if (slot.page.empty() || is_wanted(slot.page)) continue;
    if (EnginePage* hidden = binding.Find(slot.page)) hidden->Answer(engine::HidePage{.page_id = hidden->id()});
    Detach(slot);
  }

  // A page keeps the view it already has, so its native view stays where it
  // is; a page new to the window takes a free view, or a new one.
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  std::vector<std::string> attached;
  std::vector<Slot> ordered;
  for (const PageSlot& place : wanted) {
    auto showing = std::ranges::find(slots_, place.page, &Slot::page);
    if (showing == slots_.end()) {
      showing = std::ranges::find_if(slots_, [](const Slot& slot) { return slot.view && slot.page.empty(); });
      if (showing == slots_.end()) {
        Slot made;
        made.view = contents->AddChildView(std::make_unique<views::WebView>(profile_));
        made.view->SetVisible(false);
        slots_.push_back(std::move(made));
        showing = slots_.end() - 1;
      }
      showing->corner_radius = place.corner_radius;
      Attach(*showing, place.page, binding.Find(place.page)->web_contents());
      attached.push_back(place.page);
    } else if (showing->corner_radius != place.corner_radius) {
      showing->corner_radius = place.corner_radius;
      showing->view->holder()->SetNativeViewCornerRadii(gfx::RoundedCornersF(place.corner_radius));
    }
    showing->above = place.above;
    ordered.push_back(std::move(*showing));
    // Moved out: the slot left behind is skipped below.
    showing->view = nullptr;
  }
  for (Slot& slot : slots_) {
    if (slot.view) ordered.push_back(std::move(slot));
  }
  slots_ = std::move(ordered);

  contents->pages.clear();
  for (size_t index = 0; index < slots_.size(); ++index) {
    contents->pages.emplace_back(slots_[index].view, index < wanted.size() ? wanted[index].bounds : gfx::Rect());
  }
  Restack();
  contents->InvalidateLayout();

  const std::string in_use = is_wanted(focused) ? focused : std::string();
  const bool focus_moved = in_use != focused_page_;
  focused_page_ = in_use;
  for (const std::string& page : attached) {
    if (page == in_use) continue;
    if (EnginePage* shown = binding.Find(page)) shown->Answer(engine::ShowPage{.page_id = shown->id()});
  }
  // Showing a page focuses it, so the page in use is shown after the others,
  // and the raised WebUI takes the keyboard back from it.
  if (!in_use.empty() && (focus_moved || !attached.empty())) {
    if (EnginePage* shown = binding.Find(in_use)) shown->Answer(engine::ShowPage{.page_id = shown->id()});
  }
  if (focus_moved || !attached.empty()) FocusInUse();
}

bool LinuxWindow::ShowPage(const std::string& page) {
  SetPageLayout({PageSlot{.page = page, .bounds = single_bounds_, .corner_radius = kPageCornerRadius}}, page);
  single_ = true;
  return SlotShowing(page) != nullptr;
}

void LinuxWindow::ShowNoPage() {
  SetPageLayout({}, std::string());
  single_ = true;
}

void LinuxWindow::ReleasePage(const std::string& page) {
  Slot* slot = SlotShowing(page);
  if (!slot) return;
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  for (auto& [view, bounds] : contents->pages) {
    if (view == slot->view) bounds = gfx::Rect();
  }
  Detach(*slot);
  if (focused_page_ == page) focused_page_.clear();
  contents->InvalidateLayout();
}

void LinuxWindow::SetPageBounds(const gfx::Rect& bounds) {
  single_bounds_ = bounds;
  if (!single_ || slots_.empty() || slots_.front().page.empty()) return;
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  if (contents->pages.empty() || contents->pages.front().second == bounds) return;
  contents->pages.front().second = bounds;
  contents->InvalidateLayout();
}

void LinuxWindow::Attach(Slot& slot, const std::string& page, content::WebContents* contents) {
  slot.page = page;
  slot.view->SetWebContents(contents);
  slot.view->SetVisible(true);
  // The mask goes with the native view, so each page attached takes it.
  slot.view->holder()->SetNativeViewCornerRadii(gfx::RoundedCornersF(slot.corner_radius));
  slot.focus = std::make_unique<FocusObserver>(
      contents, base::BindRepeating(&LinuxWindow::PageFocused, base::Unretained(this), page));
}

void LinuxWindow::Detach(Slot& slot) {
  slot.focus.reset();
  slot.page.clear();
  slot.above = false;
  if (!slot.view) return;
  slot.view->SetWebContents(nullptr);
  slot.view->SetVisible(false);
}

LinuxWindow::Slot* LinuxWindow::SlotShowing(const std::string& page) {
  if (page.empty()) return nullptr;
  auto showing = std::ranges::find(slots_, page, &Slot::page);
  return showing == slots_.end() ? nullptr : &*showing;
}

void LinuxWindow::Restack() {
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  std::vector<views::View*> order;
  if (!overlay_raised_) order.push_back(ui_);
  for (const Slot& slot : slots_) {
    if (!overlay_raised_ || !slot.above) order.push_back(slot.view);
  }
  if (overlay_raised_) order.push_back(ui_);
  for (const Slot& slot : slots_) {
    if (overlay_raised_ && slot.above) order.push_back(slot.view);
  }
  order.push_back(float_);
  // The views' order is the native windows' order: the last child draws on
  // top and takes the pointer.
  for (size_t index = 0; index < order.size(); ++index) contents->ReorderChildView(order[index], index);
  widget_->ReorderNativeViews();
}

void LinuxWindow::FocusInUse() {
  Slot* slot = SlotShowing(focused_page_);
  if (overlay_raised_ && !(slot && slot->above)) {
    ui_->RequestFocus();
  } else if (slot) {
    slot->view->RequestFocus();
  }
}

// The WebUI decides whether the page becomes the one in use, as the Mac's
// split surface does: a split's other card does, a page under a Peek cannot
// be reached.
void LinuxWindow::PageFocused(const std::string& page) {
  if (page != focused_page_) ReportPageFocused(page);
}

void LinuxWindow::SetFloat(const gfx::Rect& bounds, bool focus) {
  auto* contents = static_cast<Contents*>(delegate_.GetContentsView());
  content::WebContents* float_contents = float_->web_contents();
  if (content::RenderWidgetHostView* view = float_contents ? float_contents->GetRenderWidgetHostView() : nullptr) {
    view->SetBackgroundColor(SK_ColorTRANSPARENT);
  }
  if (contents->float_bounds != bounds) {
    contents->float_bounds = bounds;
    contents->PlaceFloating();
  }
  if (bounds.IsEmpty()) {
    // The keyboard goes back to the page the surface took it from.
    if (float_focused_) FocusInUse();
    float_focused_ = false;
  } else if (focus) {
    float_->RequestFocus();
    float_focused_ = true;
  }
}

void LinuxWindow::SetOverlay(bool raised) {
  if (raised == overlay_raised_) return;
  overlay_raised_ = raised;
  // The WebUI paints its own backdrop; where it paints nothing, raised, the
  // pages under it show through.
  content::WebContents* ui_contents = ui_->web_contents();
  if (content::RenderWidgetHostView* view = ui_contents ? ui_contents->GetRenderWidgetHostView() : nullptr) {
    view->SetBackgroundColor(SK_ColorTRANSPARENT);
  }
  Restack();
  FocusInUse();
}

void LinuxWindow::Closing() {
  // The window does not own the pages it shows; it lets go before they go.
  for (Slot& slot : slots_) Detach(slot);
  focused_page_.clear();
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
