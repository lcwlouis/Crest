#include "chrome/browser/ui/crest/crest_linux_window.h"

#include <algorithm>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_browsers.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_webui_linux.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/gfx/geometry/vector2d.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace crest {

namespace {

// The windows open now, in the order they opened.
std::vector<LinuxWindow*>& Windows() {
  static base::NoDestructor<std::vector<LinuxWindow*>> windows;
  return *windows;
}

// Counts the windows' uses, which orders them by when each was used last.
uint64_t g_uses = 0;

// The page's corners, BrowserChromeLayout.pageCornerRadius on the Mac.
constexpr float kPageCornerRadius = 13;

// How far a new window opens down and to the right of the one in use, as the
// Mac's windows cascade. Wayland places windows itself and ignores it.
constexpr int kCascadeStep = 22;

// --- Saved frames -------------------------------------------------------------
// Each browser window keeps its frame under the core's id for it, as the
// Mac's window keeps it under its autosave name, so a window the launch
// reopens comes back where it was. Read once off the UI thread at start,
// written there a moment after the frames change.

struct Frame {
  gfx::Rect bounds;
  bool maximized = false;
};

struct SavedFrames {
  base::FilePath file;
  bool read = false;
  std::map<std::string, Frame> by_window;
  base::OneShotTimer save;
  scoped_refptr<base::SequencedTaskRunner> disk;
};

SavedFrames& Frames() {
  static base::NoDestructor<SavedFrames> frames;
  return *frames;
}

// How long the frames wait after a change before they are written.
constexpr base::TimeDelta kFrameSaveDelay = base::Seconds(1);

std::string ReadFramesFile(const base::FilePath& file) {
  std::string contents;
  if (!base::ReadFileToStringWithMaxSize(file, &contents, 1 << 20)) return std::string();
  return contents;
}

void WriteFrames() {
  SavedFrames& frames = Frames();
  frames.save.Stop();
  if (frames.file.empty() || !frames.disk) return;
  base::DictValue saved;
  for (const auto& [window, frame] : frames.by_window) {
    base::DictValue entry;
    entry.Set("x", frame.bounds.x());
    entry.Set("y", frame.bounds.y());
    entry.Set("width", frame.bounds.width());
    entry.Set("height", frame.bounds.height());
    entry.Set("maximized", frame.maximized);
    saved.Set(window, std::move(entry));
  }
  std::optional<std::string> json = base::WriteJson(saved);
  if (!json) return;
  frames.disk->PostTask(FROM_HERE, base::BindOnce(
                                       [](const base::FilePath& file, const std::string& json) {
                                         if (!base::WriteFile(file, json)) {
                                           LOG(WARNING) << "Crest could not keep its window frames.";
                                         }
                                       },
                                       frames.file, std::move(*json)));
}

void SaveFramesSoon() {
  Frames().save.Start(FROM_HERE, kFrameSaveDelay, base::BindOnce(&WriteFrames));
}

// The window's contents: the WebUI fills them, and each page sits over it in
// the bounds the WebUI last named, which the WebUI lays out again on resize.
class Contents final : public views::View {
 public:
  explicit Contents(const gfx::Size& minimum) : minimum_(minimum) {}

  // views::View:
  gfx::Size GetMinimumSize() const override { return minimum_; }

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

 private:
  const gfx::Size minimum_;
};

}  // namespace

// The Mac opens a browser window at 1440 by 900 with a 500 by 350 minimum,
// small enough for two windows side by side on a laptop; Fedora's laptops
// have less room, so it opens smaller with the same minimum.
const LinuxWindow::Kind LinuxWindow::Kind::kBrowser = {
    .name = "browser", .page = "", .size = gfx::Size(1280, 820), .minimum = gfx::Size(500, 350), .browses = true};
const LinuxWindow::Kind LinuxWindow::Kind::kQuick = {
    .name = "quick", .page = "quick.html", .size = gfx::Size(720, 460), .minimum = gfx::Size(600, 400),
    .browses = false};

// static
const LinuxWindow::Kind* LinuxWindow::Kind::Named(std::string_view name) {
  for (const Kind* kind : {&kBrowser, &kQuick}) {
    if (name == kind->name) return kind;
  }
  return nullptr;
}

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
LinuxWindow* LinuxWindow::Open(Profile* profile, const Kind& kind, const std::string& id, const std::string& query,
                               bool activates) {
  // A window opening over one in use cascades from it.
  LinuxWindow* in_use = Active();
  auto* window = new LinuxWindow(profile, kind, id);
  gfx::Rect bounds(gfx::Point(80, 80), kind.size);
  if (in_use) bounds.set_origin(in_use->widget()->GetWindowBoundsInScreen().origin() +
                                gfx::Vector2d(kCascadeStep, kCascadeStep));
  // A window the launch reopens opens where it was.
  std::optional<Frame> saved;
  if (kind.browses && !id.empty() && Frames().read) {
    window->frame_restored_ = true;
    if (auto found = Frames().by_window.find(id); found != Frames().by_window.end()) {
      saved = found->second;
      bounds = saved->bounds;
    }
  }
  views::Widget::InitParams params(views::Widget::InitParams::CLIENT_OWNS_WIDGET,
                                   views::Widget::InitParams::TYPE_WINDOW);
  params.delegate = &window->delegate_;
  // Kept on the display it is most on, as a cascade can run off the screen.
  params.bounds = OnScreen(bounds);
  params.wm_class_name = "crest";
  params.wm_class_class = "Crest";
  params.name = kind.browses ? "CrestWindow" : "CrestQuickWindow";
  window->widget_->Init(std::move(params));
  window->observation_.Observe(window->widget_.get());
  GURL::Replacements address;
  address.SetPathStr(kind.page);
  if (!query.empty()) address.SetQueryStr(query);
  window->ui_->LoadInitialURL(GURL(kCrestUIURL).ReplaceComponents(address));
  window->float_->LoadInitialURL(GURL(kCrestFloatURL));
  // A window opened behind the one in use stays behind it in the order of
  // use too, until the person comes to it.
  if (activates || !GetLinuxUI()) {
    window->used_ = ++g_uses;
    SetLinuxUI(&window->ui_shell_);
  }
  if (activates) {
    window->widget_->Show();
  } else {
    window->widget_->ShowInactive();
  }
  if (saved && saved->maximized) window->widget_->Maximize();
  return window;
}

// static
void LinuxWindow::LoadFrames(const base::FilePath& file) {
  SavedFrames& frames = Frames();
  if (frames.disk) return;
  frames.file = file;
  // Blocks shutdown, so the frames a quit kept reach the disk.
  frames.disk = base::ThreadPool::CreateSequencedTaskRunner(
      {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
  frames.disk->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&ReadFramesFile, file), base::BindOnce([](std::string json) {
        SavedFrames& frames = Frames();
        frames.read = true;
        if (std::optional<base::DictValue> saved = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC)) {
          for (const auto [window, value] : *saved) {
            const base::DictValue* entry = value.GetIfDict();
            if (!entry) continue;
            const std::optional<int> x = entry->FindInt("x");
            const std::optional<int> y = entry->FindInt("y");
            const std::optional<int> width = entry->FindInt("width");
            const std::optional<int> height = entry->FindInt("height");
            if (!x || !y || !width || !height || *width <= 0 || *height <= 0) continue;
            // A frame a window kept since it opened stays the newer one.
            frames.by_window.try_emplace(window, Frame{.bounds = gfx::Rect(*x, *y, *width, *height),
                                                       .maximized = entry->FindBool("maximized").value_or(false)});
          }
        }
        for (LinuxWindow* window : Windows()) window->RestoreFrame();
      }));
}

// static
LinuxWindow* LinuxWindow::Find(const std::string& id) {
  if (id.empty()) return nullptr;
  auto found = std::ranges::find(Windows(), id, &LinuxWindow::id_);
  return found == Windows().end() ? nullptr : *found;
}

// static
gfx::Rect LinuxWindow::OnScreen(const gfx::Rect& bounds) {
  display::Screen* screen = display::Screen::Get();
  if (!screen) return bounds;
  gfx::Rect placed = bounds;
  placed.AdjustToFit(screen->GetDisplayMatching(bounds).work_area());
  return placed;
}

// static
LinuxWindow* LinuxWindow::Active() {
  LinuxWindow* latest = nullptr;
  for (LinuxWindow* window : Windows()) {
    if (window->widget_->IsActive()) return window;
    if (!latest || window->used_ > latest->used_) latest = window;
  }
  return latest;
}

// static
LinuxWindow* LinuxWindow::Drawing(const content::WebContents* contents) {
  if (!contents) return nullptr;
  for (LinuxWindow* window : Windows()) {
    if (window->ui_contents() == contents || window->float_contents() == contents) return window;
  }
  return nullptr;
}

// static
std::vector<std::string> LinuxWindow::Stacked() {
  std::vector<LinuxWindow*> browsing;
  for (LinuxWindow* window : Windows()) {
    if (window->kind_.browses && !window->id_.empty()) browsing.push_back(window);
  }
  std::ranges::sort(browsing, std::ranges::greater(), &LinuxWindow::used_);
  std::vector<std::string> ids;
  for (LinuxWindow* window : browsing) ids.push_back(window->id_);
  return ids;
}

// static
bool LinuxWindow::AnyBrowsing() {
  return std::ranges::any_of(Windows(), [](const LinuxWindow* window) { return window->kind_.browses; });
}

// static
void LinuxWindow::CloseAll() {
  // Each closes later, once its widget unwinds; the list stays as it is
  // until then.
  for (LinuxWindow* window : std::vector<LinuxWindow*>(Windows())) window->Close();
}

// static
void LinuxWindow::ReleaseEverywhere(const std::string& page) {
  for (LinuxWindow* window : Windows()) window->ReleasePage(page);
}

LinuxWindow::LinuxWindow(Profile* profile, const Kind& kind, std::string id)
    : kind_(kind), id_(std::move(id)), widget_(std::make_unique<views::Widget>()), profile_(profile) {
  Windows().push_back(this);
  delegate_.SetTitle(kind.browses ? u"Crest" : u"Quick Window");
  delegate_.SetHasWindowSizeControls(true);
  delegate_.RegisterWindowClosingCallback(base::BindOnce(&LinuxWindow::Closing, base::Unretained(this)));

  auto contents = std::make_unique<Contents>(kind.minimum);
  contents->ui = contents->AddChildView(std::make_unique<views::WebView>(profile));
  // Over the pages, which come between the two as the layout asks for them:
  // the small surfaces that float on a page while it stays in use (the find
  // bar, notices), which the WebUI places and fills.
  contents->floating = contents->AddChildView(std::make_unique<views::WebView>(profile));
  contents->floating->SetVisible(false);
  ui_ = contents->ui;
  float_ = contents->floating;
  delegate_.SetContentsView(std::move(contents));
}

LinuxWindow::~LinuxWindow() {
  std::erase(Windows(), this);
  if (GetLinuxUI() == &ui_shell_) {
    LinuxWindow* next = Active();
    SetLinuxUI(next ? &next->ui_shell_ : nullptr);
  }
  observation_.Reset();
  // The pages' observers and views are let go before the widget that owns
  // the views.
  slots_.clear();
  // The widget goes before the delegate it holds.
  widget_.reset();
}

void LinuxWindow::Adopt(const std::string& id) {
  id_ = id;
  RestoreFrame();
}

void LinuxWindow::RestoreFrame() {
  SavedFrames& frames = Frames();
  if (!kind_.browses || id_.empty() || frame_restored_ || !frames.read) return;
  frame_restored_ = true;
  const auto found = frames.by_window.find(id_);
  if (found == frames.by_window.end()) {
    RememberFrame();
    return;
  }
  const Frame frame = found->second;
  if (widget_->IsMaximized()) widget_->Restore();
  widget_->SetBounds(OnScreen(frame.bounds));
  if (frame.maximized) widget_->Maximize();
}

void LinuxWindow::RememberFrame() {
  if (!kind_.browses || id_.empty() || !frame_restored_) return;
  if (widget_->IsMinimized() || widget_->IsFullscreen()) return;
  Frames().by_window[id_] = Frame{.bounds = widget_->GetRestoredBounds(), .maximized = widget_->IsMaximized()};
  SaveFramesSoon();
}

content::WebContents* LinuxWindow::ui_contents() const {
  return ui_ ? ui_->web_contents() : nullptr;
}

content::WebContents* LinuxWindow::float_contents() const {
  return float_ ? float_->web_contents() : nullptr;
}

void LinuxWindow::Present() {
  if (widget_->IsMinimized()) widget_->Restore();
  widget_->Show();
  widget_->Activate();
}

void LinuxWindow::Close() {
  closes_ = true;
  widget_->Close();
}

void LinuxWindow::SetTitle(const std::u16string& title) {
  delegate_.SetTitle(title);
}

// The WebUI decides, as the Mac's close gate asks the core: it forgets the
// window for the next launch, or with no other browser window open, keeps
// the windows for it as a quit does, and then closes it. A window whose
// WebUI cannot answer closes at once.
bool LinuxWindow::Delegate::OnCloseRequested(views::Widget::ClosedReason reason) {
  if (window_.closes_) return true;
  const bool last = window_.kind_.browses &&
                    std::ranges::none_of(Windows(), [this](const LinuxWindow* other) {
                      return other != &window_ && other->kind_.browses;
                    });
  return !AskToClose(window_, last);
}

void LinuxWindow::OnWidgetBoundsChanged(views::Widget* widget, const gfx::Rect& new_bounds) {
  RememberFrame();
  display::Screen* screen = display::Screen::Get();
  if (!screen || widget->IsFullscreen() || widget->IsMaximized() || widget->IsMinimized()) return;
  const gfx::Rect window = widget->GetWindowBoundsInScreen();
  for (const display::Display& display : screen->GetAllDisplays()) {
    if (display.work_area().Intersects(window)) return;
  }
  // Placed where no display shows it: onto the one nearest, which it then
  // intersects, so this does not run again for the move, which keeps the
  // frame it comes back at.
  widget->SetBounds(OnScreen(window));
}

void LinuxWindow::OnWidgetActivationChanged(views::Widget* widget, bool active) {
  if (active) {
    used_ = ++g_uses;
    SetLinuxUI(&ui_shell_);
    // The window coming into use brings the page in use there with it, as
    // the Mac's key window does.
    EngineBinding::Get().Browsers().WindowInUse(
        [this](content::WebContents* contents) { return Shows(contents); });
    FocusInUse();
  }
  ReportWindowActive(*this, active);
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

// A view shows in one window at a time: the window that showed the page
// lets it go first, and hears that it left.
void LinuxWindow::Surrender(const std::string& page) {
  if (!SlotShowing(page)) return;
  ReleasePage(page);
  ReportPageLeft(*this, page);
}

bool LinuxWindow::Shows(const content::WebContents* contents) const {
  return std::ranges::any_of(slots_, [contents](const Slot& slot) {
    return !slot.page.empty() && slot.view && slot.view->web_contents() == contents;
  });
}

void LinuxWindow::Attach(Slot& slot, const std::string& page, content::WebContents* contents) {
  for (LinuxWindow* other : Windows()) {
    if (other != this) other->Surrender(page);
  }
  // A tab's page another window's Browser keeps comes to this window's
  // Browser, which the WebUI asks the core and the engine for, as the Mac's
  // window moves a shared page it shows.
  if (kind_.browses && !id_.empty()) {
    EnginePage* engine_page = EngineBinding::Get().Find(page);
    if (engine_page && engine_page->window() != id_) ReportPageArrived(*this, page);
  }
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

// A window in the background moves no focus, since focusing a view there
// would take activation from the window in use: it focuses its page in use
// once it comes into use.
void LinuxWindow::FocusInUse() {
  if (!widget_->IsActive()) return;
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
  if (page != focused_page_) ReportPageFocused(*this, page);
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
  // The window keeps its frame, as the Mac's autosaved frame outlives its
  // window; the last browser window's close writes the frames at once.
  if (kind_.browses && !id_.empty()) {
    RememberFrame();
    const bool last = std::ranges::none_of(
        Windows(), [this](const LinuxWindow* other) { return other != this && other->kind_.browses; });
    if (last) WriteFrames();
  }
  // The window does not own the pages it shows; it lets go before they go.
  for (Slot& slot : slots_) Detach(slot);
  focused_page_.clear();
  observation_.Reset();
  std::erase(Windows(), this);
  if (GetLinuxUI() == &ui_shell_) {
    LinuxWindow* next = Active();
    SetLinuxUI(next ? &next->ui_shell_ : nullptr);
  }
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
  return ClaimShortcut(window_, event, page_declined);
}

void LinuxWindow::UI::FocusLocation() {
  PerformCommand(window_, "OpenLocation");
}

// TODO(linux): the rest arrive with the WebUI surfaces that answer them.
void LinuxWindow::UI::BookmarkActivePage() {}
void LinuxWindow::UI::TranslatePage() {}
void LinuxWindow::UI::TranslateText(const std::u16string& text) {}
void LinuxWindow::UI::ShowTabSearch() {
  PerformCommand(window_, "NewTab");
}
void LinuxWindow::UI::ShowUnavailable(UnavailableFeature feature) {}
void LinuxWindow::UI::ShowEngineNotice(const std::u16string& message, EngineNoticeKind kind) {}

}  // namespace crest
