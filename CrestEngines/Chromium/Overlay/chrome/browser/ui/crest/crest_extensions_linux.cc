#include "chrome/browser/ui/crest/crest_extensions_linux.h"

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/location.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/extensions/api/side_panel/side_panel_service.h"
#include "chrome/browser/extensions/commands/command_service.h"
#include "chrome/browser/extensions/extension_action_runner.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/extensions/extension_view.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/extensions/extension_view_host_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_browsers.h"
#include "chrome/browser/ui/crest/crest_engine_extensions.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_engine_profiles.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "extensions/browser/event_router.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_host_observer.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/permissions/active_tab_permission_granter.h"
#include "extensions/common/api/extension_action/action_info.h"
#include "extensions/common/command.h"
#include "extensions/common/extension.h"
#include "extensions/common/mojom/context_type.mojom.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/accelerators/command.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/gfx/geometry/size.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_observer.h"
#include "url/gurl.h"

namespace crest {

namespace {

using ShownCallback = base::OnceCallback<void(extensions::ExtensionHost*)>;

class ExtensionsHandler;

// Every chrome://crest page's extension handler. A window's main WebUI is
// the one whose contents the window names as its UI.
std::vector<ExtensionsHandler*>& Handlers() {
  static base::NoDestructor<std::vector<ExtensionsHandler*>> handlers;
  return *handlers;
}

ExtensionsHandler* HandlerFor(const LinuxWindow& window);

// The spelling the binding keys pages, profiles and windows by, from the
// WebUI's; empty when `value` is not an id.
std::string KeyOf(const base::Value& value) {
  const std::optional<engine::Guid> id = value.is_string() ? ParseGuid(value.GetString()) : std::nullopt;
  return id ? GuidText(*id) : std::string();
}

// A rect the WebUI sent as four numbers from `index`, in its CSS pixels,
// which are the window contents' at its natural zoom.
std::optional<gfx::Rect> RectAt(const base::ListValue& args, size_t index) {
  if (args.size() < index + 4) return std::nullopt;
  int values[4];
  for (size_t offset = 0; offset < 4; ++offset) {
    const base::Value& value = args[index + offset];
    if (!value.is_int() && !value.is_double()) return std::nullopt;
    values[offset] = static_cast<int>(value.GetDouble());
  }
  if (values[2] < 0 || values[3] < 0) return std::nullopt;
  return gfx::Rect(values[0], values[1], values[2], values[3]);
}

// Tells the main WebUI of `window` `event`; false when it cannot hear it.
bool Tell(LinuxWindow& window, const std::string& event, base::Value value);

// --- The surfaces -------------------------------------------------------------

// An extension document Crest shows in one of its windows: an action's popup
// or a side panel. It is a view of the window, which owns it, and it owns
// the extension's host, so the document goes with the window, with the page
// it belongs to, or when the extension closes it. Hosting follows the Mac
// host's ExtensionPopup and ExtensionSidePanel (crest_chrome_host.mm), and
// the view is a WebView as Chromium's own ExtensionViewViews is.
class ExtensionSurface final : public views::WebView,
                               public extensions::ExtensionView,
                               public extensions::ExtensionHostObserver,
                               public views::WidgetObserver {
 public:
  enum class Kind { kPopup, kSidePanel };

  ExtensionSurface(LinuxWindow& window,
                   Kind kind,
                   std::unique_ptr<extensions::ExtensionViewHost> host,
                   std::string extension_id,
                   std::string page,
                   gfx::Rect anchor,
                   content::WebContents* opened_over = nullptr,
                   ShownCallback shown = ShownCallback())
      : views::WebView(host->host_contents()->GetBrowserContext()),
        window_(&window),
        kind_(kind),
        host_(std::move(host)),
        extension_id_(std::move(extension_id)),
        page_(std::move(page)),
        anchor_(anchor),
        opened_over_(opened_over ? std::make_optional(opened_over->GetWeakPtr()) : std::nullopt),
        shown_(std::move(shown)) {
    host_->set_view(this);
    host_->AddObserver(this);
    // The document called window.close(), or for a panel, the extension
    // retracted it. The host is still in its call, so the surface goes after.
    host_->SetCloseHandler(base::BindOnce(
        [](base::WeakPtr<ExtensionSurface> surface, extensions::ExtensionHost*) {
          base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
              FROM_HERE, base::BindOnce(&ExtensionSurface::Dismiss, surface, /*tell=*/true));
        },
        weak_factory_.GetWeakPtr()));
    SetWebContents(host_->host_contents());
    SetVisible(false);
    holder()->SetNativeViewCornerRadii(kind_ == Kind::kPopup ? gfx::RoundedCornersF(kPopupCornerRadius)
                                                             : gfx::RoundedCornersF(0, 0, kCardCornerRadius,
                                                                                    kCardCornerRadius));
    host_->CreateRendererSoon();
  }

  ExtensionSurface(const ExtensionSurface&) = delete;
  ExtensionSurface& operator=(const ExtensionSurface&) = delete;

  ~ExtensionSurface() override {
    if (shown_) std::move(shown_).Run(nullptr);
    focus_.reset();
    widget_observation_.Reset();
    SetWebContents(nullptr);
    if (host_) {
      host_->RemoveObserver(this);
      host_.reset();
    }
  }

  Kind kind() const { return kind_; }
  const std::string& extension_id() const { return extension_id_; }
  const std::string& page() const { return page_; }
  content::WebContents* page_contents() const { return opened_over_ ? opened_over_->get() : nullptr; }
  bool IsOpen() const { return host_ != nullptr; }
  base::WeakPtr<ExtensionSurface> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

  // The surface goes: its window destroys it. A surface that goes on its own
  // (the extension closed it, the person clicked elsewhere) tells its
  // window's WebUI when `tell`; one the WebUI or the page's end let go does
  // not. Nothing may touch `this` afterwards.
  void Dismiss(bool tell) {
    LinuxWindow* window = window_;
    if (tell) {
      if (kind_ == Kind::kPopup) {
        Tell(*window, "crest-extension-popup-closed", base::Value(extension_id_));
      } else {
        base::DictValue closed;
        closed.Set("pageId", base::ToLowerASCII(page_));
        closed.Set("extensionId", extension_id_);
        Tell(*window, "crest-side-panel-closed", base::Value(std::move(closed)));
      }
    }
    window->RemoveExtensionView(this);
  }

  // A side panel goes where the WebUI's card holds it; empty hides it.
  void PlaceInCard(const gfx::Rect& bounds) {
    if (kind_ != Kind::kSidePanel) return;
    SetBoundsRect(bounds);
    SetVisible(!bounds.IsEmpty());
  }

  // extensions::ExtensionView:
  gfx::NativeView GetNativeView() override {
    return host_ ? host_->host_contents()->GetNativeView() : gfx::NativeView();
  }
  void ResizeDueToAutoResize(content::WebContents*, const gfx::Size& size) override {
    // A panel is laid out by its card, so its document never resizes it.
    if (kind_ != Kind::kPopup) return;
    content_size_ = gfx::Size(std::clamp(size.width(), kMinimumSize, kMaximumWidth),
                              std::clamp(size.height(), kMinimumSize, kMaximumHeight));
    if (presented_) Place();
  }
  void RenderFrameCreated(content::RenderFrameHost* frame) override {
    if (kind_ != Kind::kPopup) return;
    if (content::RenderWidgetHostView* view = frame->GetView()) {
      view->EnableAutoResize(gfx::Size(kMinimumSize, kMinimumSize), gfx::Size(kMaximumWidth, kMaximumHeight));
    }
  }
  bool HandleKeyboardEvent(content::WebContents*, const input::NativeWebKeyboardEvent& event) override {
    // Escape closes a popup, as it closes the popover it replaces.
    if (kind_ != Kind::kPopup || event.GetType() != input::NativeWebKeyboardEvent::Type::kRawKeyDown ||
        event.windows_key_code != ui::VKEY_ESCAPE) {
      return false;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&ExtensionSurface::Dismiss, weak_factory_.GetWeakPtr(), /*tell=*/true));
    return true;
  }
  void OnLoaded() override {
    if (kind_ != Kind::kPopup || presented_) return;
    if (!StillOverItsPage()) {
      // The host is still delivering this load, so the surface goes after.
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&ExtensionSurface::Dismiss, weak_factory_.GetWeakPtr(), /*tell=*/true));
      return;
    }
    presented_ = true;
    Place();
    SetVisible(true);
    RequestFocus();
    if (host_) {
      host_->host_contents()->Focus();
      // Transient like the popover it replaces: a click anywhere else in
      // Crest takes the keyboard from it, and it closes.
      focus_ = std::make_unique<FocusWatch>(host_->host_contents(), weak_factory_.GetWeakPtr());
    }
    if (views::Widget* widget = GetWidget(); widget && !widget_observation_.IsObserving()) {
      widget_observation_.Observe(widget);
    }
    if (shown_ && host_) std::move(shown_).Run(host_.get());
  }

  // extensions::ExtensionHostObserver:
  void OnExtensionHostDestroyed(extensions::ExtensionHost* host) override {
    if (host_.get() != host) return;
    host_->RemoveObserver(this);
    // The host is going away under its own owner's call; it is not ours to
    // delete twice.
    host_.release();
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&ExtensionSurface::Dismiss, weak_factory_.GetWeakPtr(), /*tell=*/true));
  }

  // views::WidgetObserver: the window moving or resizing dismisses a popup,
  // as the Mac's does, since its control moved with the layout.
  void OnWidgetBoundsChanged(views::Widget*, const gfx::Rect&) override {
    if (kind_ != Kind::kPopup) return;
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&ExtensionSurface::Dismiss, weak_factory_.GetWeakPtr(), /*tell=*/true));
  }
  void OnWidgetDestroying(views::Widget*) override { widget_observation_.Reset(); }

 private:
  static constexpr int kDefaultWidth = 360;
  static constexpr int kDefaultHeight = 320;
  static constexpr int kMinimumSize = 25;
  static constexpr int kMaximumWidth = 800;
  static constexpr int kMaximumHeight = 600;
  // The radius Crest's own controls use, and the page card's.
  static constexpr float kPopupCornerRadius = 12;
  static constexpr float kCardCornerRadius = 13;
  static constexpr int kAnchorGap = 6;
  static constexpr int kWindowMargin = 8;

  // Hears the popup's document lose the keyboard.
  class FocusWatch final : public content::WebContentsObserver {
   public:
    FocusWatch(content::WebContents* contents, base::WeakPtr<ExtensionSurface> surface)
        : content::WebContentsObserver(contents), surface_(std::move(surface)) {}
    void OnWebContentsLostFocus(content::RenderWidgetHost*) override {
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&ExtensionSurface::Dismiss, surface_, /*tell=*/true));
    }

   private:
    base::WeakPtr<ExtensionSurface> surface_;
  };

  // Whether a popup an extension opened itself may still show: while it
  // loaded, the person may have moved to another page or window. The page
  // it was opened over must still be its Browser's active tab and the page
  // in use of the window in use, as `chrome.action.openPopup()` required
  // when it was called. A popup a click opened has no such page and always
  // may.
  bool StillOverItsPage() const {
    if (!opened_over_) return true;
    content::WebContents* page = opened_over_->get();
    if (!page) return false;
    Browser* browser = EngineBinding::Get().Browsers().Holding(page);
    return browser && browser->tab_strip_model()->GetActiveWebContents() == page &&
           LinuxWindow::Active() == window_ && window_->focused_page() == page_;
  }

  // Places the popup under the control it was opened from, flipping above it
  // and sliding along the window when there is not room below or beside it.
  void Place() {
    views::View* contents = parent();
    if (!contents) return;
    const gfx::Rect area = contents->GetLocalBounds();
    const int width = content_size_.width();
    const int height = content_size_.height();
    int x = anchor_.CenterPoint().x() - width / 2;
    int y = anchor_.bottom() + kAnchorGap;
    if (y + height > area.bottom() - kWindowMargin) {
      const int above = anchor_.y() - kAnchorGap - height;
      y = above >= area.y() + kWindowMargin ? above
                                            : std::max(area.y() + kWindowMargin, area.bottom() - kWindowMargin - height);
    }
    x = std::clamp(x, area.x() + kWindowMargin, std::max(area.x() + kWindowMargin, area.right() - kWindowMargin - width));
    SetBoundsRect(gfx::Rect(x, y, width, height));
  }

  const raw_ptr<LinuxWindow> window_;
  const Kind kind_;
  std::unique_ptr<extensions::ExtensionViewHost> host_;
  const std::string extension_id_;
  const std::string page_;
  const gfx::Rect anchor_;
  const std::optional<base::WeakPtr<content::WebContents>> opened_over_;
  ShownCallback shown_;
  gfx::Size content_size_{kDefaultWidth, kDefaultHeight};
  bool presented_ = false;
  std::unique_ptr<FocusWatch> focus_;
  base::ScopedObservation<views::Widget, views::WidgetObserver> widget_observation_{this};
  base::WeakPtrFactory<ExtensionSurface> weak_factory_{this};
};

// The surfaces beside each page, by the binding's key for it, and the popup
// an action opened from a Space with no page, which only one can be at a
// time, as an action popup is transient.
struct PageSurfaces {
  base::WeakPtr<ExtensionSurface> popup;
  base::WeakPtr<ExtensionSurface> side_panel;
};

struct SurfaceState {
  std::map<std::string, PageSurfaces> pages;
  base::WeakPtr<ExtensionSurface> space_popup;
};

SurfaceState& Surfaces() {
  static base::NoDestructor<SurfaceState> state;
  return *state;
}

// Lets `surface` go without telling the WebUI: the WebUI or the page's end
// asked for it.
void Drop(base::WeakPtr<ExtensionSurface>& surface) {
  if (ExtensionSurface* held = surface.get()) held->Dismiss(/*tell=*/false);
  surface.reset();
}

// Adds a surface to `window` and keeps it as `slot`, in place of what was
// there.
ExtensionSurface* Host(LinuxWindow& window, base::WeakPtr<ExtensionSurface>& slot,
                       std::unique_ptr<ExtensionSurface> surface) {
  Drop(slot);
  const bool popup = surface->kind() == ExtensionSurface::Kind::kPopup;
  auto* added = static_cast<ExtensionSurface*>(window.AddExtensionView(std::move(surface), popup));
  slot = added->GetWeakPtr();
  return added;
}

// --- Running actions ----------------------------------------------------------

// Runs `extension_id`'s action on the page the binding keys as `key`, from
// the control at `anchor` in `window`, as the Mac's runExtension:page: does.
bool RunOnPage(LinuxWindow& window, const std::string& extension_id, const std::string& key, const gfx::Rect& anchor) {
  auto& binding = EngineBinding::Get();
  EnginePage* page = binding.Find(key);
  content::WebContents* contents = page ? page->web_contents() : nullptr;
  Browser* browser = binding.Browsers().Holding(contents);
  if (!browser || WindowForBrowser(browser) != window.widget()) return false;
  Profile* profile = browser->GetProfile();
  const extensions::Extension* extension = EngineExtensions::Usable(profile, extension_id);
  if (!extension) return false;
  // Declined rather than navigated: an extension whose files are gone would
  // otherwise show Chromium's own ERR_FILE_NOT_FOUND page in Crest's popup.
  // The WebUI states this as an unavailable action instead.
  if (!binding.Extensions().For(profile, page->profile()).IsAvailable(
          *extension, extensions::ExtensionActionManager::Get(profile)->GetExtensionAction(*extension))) {
    return false;
  }
  if (!binding.Browsers().Activate(contents)) return false;
  auto* runner = extensions::ExtensionActionRunner::GetForWebContents(contents);
  if (!runner) return false;
  // This path is invoked only by the person's click on the extension's
  // control, or its `_execute_action` key.
  const auto result = runner->RunAction(extension, /*grant_tab_permissions=*/true);
  if (result == extensions::ExtensionAction::ShowAction::kNone) return true;
  if (result == extensions::ExtensionAction::ShowAction::kToggleSidePanel) {
    // The action opens a panel instead of a popup. The card is the WebUI's,
    // so the click toggles the one this page already shows.
    binding.RequestSidePanel(key, extension_id, engine::SidePanelRequest::kToggle);
    return true;
  }
  if (result != extensions::ExtensionAction::ShowAction::kShowPopup) return false;
  auto* action = extensions::ExtensionActionManager::Get(profile)->GetExtensionAction(*extension);
  if (!action) return false;
  auto popup = extensions::ExtensionViewHostFactory::CreatePopupHost(
      *extension, action->GetPopupUrl(sessions::SessionTabHelper::IdForTab(contents).id()), browser);
  if (!popup) return false;
  Host(window, Surfaces().pages[key].popup,
       std::make_unique<ExtensionSurface>(window, ExtensionSurface::Kind::kPopup, std::move(popup), extension_id, key,
                                          anchor));
  return true;
}

// Runs a pinned action with no page open, as the Mac's
// runExtension:profile:window: does. Only an action carrying its own popup
// document can run: there is no tab to activate, grant host access for or
// inject into.
bool RunInSpace(LinuxWindow& window, const std::string& extension_id, const std::string& profile_id,
                const gfx::Rect& anchor) {
  auto& binding = EngineBinding::Get();
  Profile* profile = binding.Profiles().Find(profile_id);
  if (!profile || window.id().empty()) return false;
  Profile* owner = profile->GetOriginalProfile();
  const extensions::Extension* extension = EngineExtensions::Usable(profile, extension_id);
  if (!extension) return false;
  auto* action = extensions::ExtensionActionManager::Get(owner)->GetExtensionAction(*extension);
  if (!action || !binding.Extensions().For(profile, profile_id).IsAvailable(*extension, action)) return false;
  if (action->action_type() == extensions::ActionInfo::Type::kPage) return false;
  const GURL popup_url = action->GetPopupUrl(extensions::ExtensionAction::kDefaultTabId);
  if (!popup_url.is_valid()) return false;
  Browser* browser = binding.Browsers().ForWindow(profile_id, window.id());
  if (!browser || WindowForBrowser(browser) != window.widget()) return false;
  auto popup = extensions::ExtensionViewHostFactory::CreatePopupHost(*extension, popup_url, browser);
  if (!popup) return false;
  Host(window, Surfaces().space_popup,
       std::make_unique<ExtensionSurface>(window, ExtensionSurface::Kind::kPopup, std::move(popup), extension_id,
                                          std::string(), anchor));
  return true;
}

// Delivers a named command to its extension, granting the active-tab
// permission first so the extension can act on the page it was invoked over,
// as the Mac host's DeliverExtensionCommand does.
void DeliverExtensionCommand(Profile* profile, const extensions::Extension& extension, const std::string& command,
                             content::WebContents* contents) {
  base::ListValue args;
  args.Append(command);
  base::Value tab;
  if (contents) {
    if (auto* granter = extensions::ActiveTabPermissionGranter::FromWebContents(contents)) {
      granter->GrantIfRequested(&extension);
    }
    // The action APIs are privileged extension contexts by construction.
    const auto scrub = extensions::ExtensionTabUtil::GetScrubTabBehavior(
        &extension, extensions::mojom::ContextType::kPrivilegedExtension, contents);
    tab = base::Value(extensions::ExtensionTabUtil::CreateTabObject(contents, scrub, &extension).ToValue());
  }
  args.Append(std::move(tab));
  auto event = std::make_unique<extensions::Event>(extensions::events::COMMANDS_ON_COMMAND, "commands.onCommand",
                                                   std::move(args), profile);
  event->user_gesture = extensions::EventRouter::UserGestureState::kEnabled;
  extensions::EventRouter::Get(profile)->DispatchEventToExtension(extension.id(), std::move(event));
}

// The accelerator a key press makes, as a command binds it.
ui::Accelerator ShortcutAccelerator(const input::NativeWebKeyboardEvent& event) {
  const int modifiers = event.GetModifiers();
  int flags = ui::EF_NONE;
  if (modifiers & blink::WebInputEvent::kShiftKey) flags |= ui::EF_SHIFT_DOWN;
  if (modifiers & blink::WebInputEvent::kControlKey) flags |= ui::EF_CONTROL_DOWN;
  if (modifiers & blink::WebInputEvent::kAltKey) flags |= ui::EF_ALT_DOWN;
  if (modifiers & blink::WebInputEvent::kMetaKey) flags |= ui::EF_COMMAND_DOWN;
  return ui::Accelerator(static_cast<ui::KeyboardCode>(event.windows_key_code), flags);
}

// --- The WebUI's messages -----------------------------------------------------

class ExtensionsHandler final : public content::WebUIMessageHandler {
 public:
  ExtensionsHandler() { Handlers().push_back(this); }
  ExtensionsHandler(const ExtensionsHandler&) = delete;
  ExtensionsHandler& operator=(const ExtensionsHandler&) = delete;
  ~ExtensionsHandler() override { std::erase(Handlers(), this); }

  content::WebContents* contents() { return web_ui()->GetWebContents(); }

  // Fires `event` to the page; false while it cannot hear it.
  bool Fire(const std::string& event, const base::Value& value) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener(event, value);
    return true;
  }

  // Where a popup the extension opened itself hangs from: its pinned
  // control, or with none, the control the WebUI names for every extension.
  std::optional<gfx::Rect> AnchorFor(const std::string& extension_id) const {
    auto found = anchors_.find(extension_id);
    if (found == anchors_.end()) found = anchors_.find(std::string());
    return found == anchors_.end() ? std::nullopt : std::make_optional(found->second);
  }

  // content::WebUIMessageHandler:
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "runExtension", base::BindRepeating(&ExtensionsHandler::HandleRunExtension, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setExtensionAnchors", base::BindRepeating(&ExtensionsHandler::HandleSetAnchors, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "openSidePanel", base::BindRepeating(&ExtensionsHandler::HandleOpenSidePanel, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "placeSidePanel", base::BindRepeating(&ExtensionsHandler::HandlePlaceSidePanel, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "closeSidePanel", base::BindRepeating(&ExtensionsHandler::HandleCloseSidePanel, base::Unretained(this)));
  }

 private:
  LinuxWindow* Window() { return LinuxWindow::Drawing(contents()); }

  // args: callback id, extension id, page id (empty for none), the Space's
  // profile id when no page is open, and the control's rect. Answers whether
  // the action ran; the WebUI says so when it did not.
  void HandleRunExtension(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 8 || !args[1].is_string() || !args[2].is_string() || !args[3].is_string()) {
      ResolveJavascriptCallback(args[0], base::Value(false));
      return;
    }
    const std::string extension_id = args[1].GetString();
    const std::string page = KeyOf(args[2]);
    const std::string profile = KeyOf(args[3]);
    const std::optional<gfx::Rect> anchor = RectAt(args, 4);
    LinuxWindow* window = Window();
    bool ran = false;
    if (window && anchor && !extension_id.empty()) {
      ran = !page.empty() ? RunOnPage(*window, extension_id, page, *anchor)
                          : !profile.empty() && RunInSpace(*window, extension_id, profile, *anchor);
    }
    ResolveJavascriptCallback(args[0], base::Value(ran));
  }

  // args: one list per control, [extension id (empty for the control every
  // extension falls back to), x, y, width, height].
  void HandleSetAnchors(const base::ListValue& args) {
    std::map<std::string, gfx::Rect> anchors;
    for (const base::Value& entry : args) {
      const base::ListValue* fields = entry.GetIfList();
      if (!fields || fields->size() != 5 || !(*fields)[0].is_string()) return;
      const std::optional<gfx::Rect> rect = RectAt(*fields, 1);
      if (!rect) return;
      anchors[(*fields)[0].GetString()] = *rect;
    }
    anchors_ = std::move(anchors);
  }

  // args: callback id, extension id, page id. Makes the panel's document for
  // the page's own tab, hidden until the WebUI places its card, as the
  // Mac's openSidePanel:page:closed: does. Answers whether it could.
  void HandleOpenSidePanel(const base::ListValue& args) {
    AllowJavascript();
    const std::string extension_id = args.size() == 3 && args[1].is_string() ? args[1].GetString() : std::string();
    const std::string key = args.size() == 3 ? KeyOf(args[2]) : std::string();
    ResolveJavascriptCallback(args[0], base::Value(!extension_id.empty() && !key.empty() && OpenSidePanel(extension_id, key)));
  }

  bool OpenSidePanel(const std::string& extension_id, const std::string& key) {
    LinuxWindow* window = Window();
    EnginePage* page = EngineBinding::Get().Find(key);
    content::WebContents* contents = page ? page->web_contents() : nullptr;
    Browser* browser = EngineBinding::Get().Browsers().Holding(contents);
    if (!window || !browser) return false;
    const extensions::Extension* extension = EngineExtensions::SidePanelExtension(contents, extension_id);
    if (!extension) return false;
    auto* service = extensions::SidePanelService::Get(browser->GetProfile());
    auto options = service->GetOptions(*extension, sessions::SessionTabHelper::IdForTab(contents).id());
    if (!options.path || options.path->empty() || options.enabled == false) return false;
    const GURL url = extension->ResolveExtensionURL(*options.path);
    if (!url.is_valid()) return false;
    auto panel = extensions::ExtensionViewHostFactory::CreateSidePanelHost(
        *extension, url, browser, browser->tab_strip_model()->GetTabForWebContents(contents));
    if (!panel) return false;
    Host(*window, Surfaces().pages[key].side_panel,
         std::make_unique<ExtensionSurface>(*window, ExtensionSurface::Kind::kSidePanel, std::move(panel),
                                            extension->id(), key, gfx::Rect()));
    return true;
  }

  // args: page id, then the panel's place in the card (empty hides it).
  void HandlePlaceSidePanel(const base::ListValue& args) {
    const std::string key = args.size() == 5 ? KeyOf(args[0]) : std::string();
    const std::optional<gfx::Rect> bounds = RectAt(args, 1);
    if (key.empty() || !bounds) return;
    auto found = Surfaces().pages.find(key);
    if (found == Surfaces().pages.end()) return;
    if (ExtensionSurface* panel = found->second.side_panel.get()) panel->PlaceInCard(*bounds);
  }

  // args: page id. The person closed the card.
  void HandleCloseSidePanel(const base::ListValue& args) {
    const std::string key = args.size() == 1 ? KeyOf(args[0]) : std::string();
    auto found = Surfaces().pages.find(key);
    if (found != Surfaces().pages.end()) Drop(found->second.side_panel);
  }

  std::map<std::string, gfx::Rect> anchors_;
};

ExtensionsHandler* HandlerFor(const LinuxWindow& window) {
  content::WebContents* contents = window.ui_contents();
  for (ExtensionsHandler* handler : Handlers()) {
    if (contents && handler->contents() == contents) return handler;
  }
  return nullptr;
}

bool Tell(LinuxWindow& window, const std::string& event, base::Value value) {
  ExtensionsHandler* handler = HandlerFor(window);
  return handler && handler->Fire(event, value);
}

}  // namespace

std::unique_ptr<content::WebUIMessageHandler> MakeExtensionsHandler() {
  return std::make_unique<ExtensionsHandler>();
}

// `chrome.action.openPopup()`. Chrome shows the popup from the extension's
// button in its own toolbar, which a Crest window does not have, so Crest
// opens it over the page `browser` shows, from the control the window's WebUI
// names. As in Chrome, a popup an extension opens itself grants no access to
// the page and runs no click, and it does not replace a popup the page
// already shows.
bool OpenExtensionPopupFromEngine(BrowserWindowInterface& browser_window, const extensions::Extension& extension,
                                  ShownCallback shown) {
  // Browser is the only desktop BrowserWindowInterface.
  Browser* browser = static_cast<Browser*>(&browser_window);
  content::WebContents* contents = browser->tab_strip_model()->GetActiveWebContents();
  auto& binding = EngineBinding::Get();
  EnginePage* page = contents ? binding.PageFor(contents) : nullptr;
  if (!page || browser->IsDeleteScheduled() || binding.Browsers().Holding(contents) != browser) return false;
  const std::string window_id = binding.Browsers().WindowOf(browser);
  LinuxWindow* window = window_id.empty() ? nullptr : LinuxWindow::Find(window_id);
  if (!window || LinuxWindow::Active() != window || window->focused_page() != page->key()) return false;
  PageSurfaces& surfaces = Surfaces().pages[page->key()];
  if (surfaces.popup && surfaces.popup->IsOpen()) return false;
  Profile* profile = browser->GetProfile();
  auto* action = extensions::ExtensionActionManager::Get(profile)->GetExtensionAction(extension);
  if (!action || !binding.Extensions().For(profile, page->profile()).IsAvailable(extension, action)) return false;
  const GURL popup_url = action->GetPopupUrl(sessions::SessionTabHelper::IdForTab(contents).id());
  if (!popup_url.is_valid()) return false;
  ExtensionsHandler* handler = HandlerFor(*window);
  const std::optional<gfx::Rect> anchor = handler ? handler->AnchorFor(extension.id()) : std::nullopt;
  if (!anchor) return false;
  auto popup = extensions::ExtensionViewHostFactory::CreatePopupHost(extension, popup_url, browser);
  if (!popup) return false;
  Host(*window, surfaces.popup,
       std::make_unique<ExtensionSurface>(*window, ExtensionSurface::Kind::kPopup, std::move(popup), extension.id(),
                                          page->key(), *anchor, contents, std::move(shown)));
  return true;
}

void ReleaseExtensionViews(const std::string& page) {
  auto& pages = Surfaces().pages;
  auto found = pages.find(page);
  if (found == pages.end()) return;
  Drop(found->second.popup);
  Drop(found->second.side_panel);
  pages.erase(page);
}

void ReleaseSpaceExtensionPopup() {
  Drop(Surfaces().space_popup);
}

// Drops any open panel card for `extension_id` in `profile`, for one tab or
// for all of them. An extension that unloads or turns its entry off has no
// panel left to show.
void RetractExtensionSidePanels(Profile* profile, const std::string& extension_id, std::optional<int> tab) {
  if (!profile) return;
  std::vector<std::string> retracting;
  for (const auto& [page, surfaces] : Surfaces().pages) {
    ExtensionSurface* panel = surfaces.side_panel.get();
    if (!panel || panel->extension_id() != extension_id) continue;
    EnginePage* engine_page = EngineBinding::Get().Find(page);
    content::WebContents* contents = engine_page ? engine_page->web_contents() : nullptr;
    if (!contents) continue;
    // An off-the-record page's extensions are its original profile's.
    if (Profile::FromBrowserContext(contents->GetBrowserContext())->GetOriginalProfile() !=
        profile->GetOriginalProfile()) {
      continue;
    }
    if (tab && sessions::SessionTabHelper::IdForTab(contents).id() != *tab) continue;
    retracting.push_back(page);
  }
  // A retracted card tells its WebUI, which may change what the window
  // hosts, so each is found again.
  for (const std::string& page : retracting) {
    auto found = Surfaces().pages.find(page);
    if (found == Surfaces().pages.end()) continue;
    if (ExtensionSurface* panel = found->second.side_panel.get()) panel->Dismiss(/*tell=*/true);
  }
}

// chrome.commands. Crest owns the key path, so a key nothing claimed is
// matched against the extension keybindings here rather than through
// Chrome's Views keybinding registry, which this build never creates.
// Modelled on ExtensionKeybindingRegistry, as the Mac host's
// dispatchExtensionShortcut:page: is.
bool DispatchExtensionShortcut(LinuxWindow& window, const input::NativeWebKeyboardEvent& event) {
  if (event.GetType() != input::NativeWebKeyboardEvent::Type::kRawKeyDown) return false;
  EnginePage* page = EngineBinding::Get().Find(window.focused_page());
  content::WebContents* contents = page ? page->web_contents() : nullptr;
  Browser* browser = EngineBinding::Get().Browsers().Holding(contents);
  if (!browser) return false;
  const ui::Accelerator accelerator = ShortcutAccelerator(event);
  if (accelerator.key_code() == ui::VKEY_UNKNOWN) return false;
  Profile* profile = browser->GetProfile();
  auto* commands = extensions::CommandService::Get(profile);
  if (!commands) return false;
  for (const auto& extension : extensions::ExtensionRegistry::Get(profile)->enabled_extensions()) {
    if (!EngineExtensions::RunsIn(profile, *extension)) continue;
    const auto& id = extension->id();
    // `_execute_action` is the action itself, so the WebUI runs it through
    // the same path as a click on the extension's own control.
    extensions::Command action;
    bool active = false;
    if (commands->GetExtensionActionCommand(id, extensions::ActionInfo::Type::kAction,
                                            extensions::CommandService::ACTIVE, &action, &active) &&
        active && action.accelerator() == accelerator) {
      return Tell(window, "crest-extension-action", base::Value(id));
    }
    ui::CommandMap named;
    if (!commands->GetNamedCommands(id, extensions::CommandService::ACTIVE, extensions::CommandService::REGULAR,
                                    &named)) {
      continue;
    }
    for (const auto& [name, command] : named) {
      if (command.accelerator() != accelerator) continue;
      // The extension may find its page as the active tab rather than read
      // the one the command names, as a click on its control finds it.
      EngineBinding::Get().Browsers().Activate(contents);
      DeliverExtensionCommand(profile, *extension, name, contents);
      return true;
    }
  }
  return false;
}

}  // namespace crest
