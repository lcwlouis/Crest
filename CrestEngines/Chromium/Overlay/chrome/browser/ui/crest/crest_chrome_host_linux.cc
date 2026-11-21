// Crest's host on Linux: the hooks crest_chrome_host.mm implements for the
// Mac, over a shell Chromium draws itself. The Mac host hands the engine
// binding to Crest's Swift UI, which creates the core; here the browser
// process creates the core (CoreHost) and opens Crest's first window
// (LinuxWindow), drawn by the chrome://crest WebUI, which opens the rest.
//
// This is the first step of the Linux shell. Hooks whose Mac behavior needs a
// Crest UI that Linux does not draw yet keep Chromium's own behavior or
// decline, and say so where they do.

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/auto_reset.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/crest/crest_chrome_hooks.h"
#include "chrome/browser/ui/crest/crest_core_host_linux.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_browsers.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_extension_prompt.h"
#include "chrome/browser/ui/crest/crest_extensions_linux.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "chrome/browser/ui/crest/crest_permission_prompt.h"
#include "chrome/browser/ui/crest/crest_webui_linux.h"
#include "chrome/browser/ui/toasts/api/toast_id.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/permissions/permission_request.h"
#include "components/permissions/request_type.h"
#include "components/renderer_context_menu/render_view_context_menu_observer.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/drop_data.h"
#include "extensions/common/extension.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace {

struct HostState {
  bool started = false;
  bool disposing = false;
  bool quitting = false;
  raw_ptr<crest::LinuxUI> ui = nullptr;
  // The profile Crest's WebUI runs in, Chromium's bootstrap profile.
  raw_ptr<Profile> ui_profile = nullptr;
  // A permission request being answered; Chromium raises it again while it
  // takes the answer, and that request already has one.
  raw_ptr<const permissions::PermissionPrompt::Delegate> answering_permission = nullptr;
};

HostState& State() {
  static base::NoDestructor<HostState> state;
  return *state;
}

// What only the platform does for the portable binding: the Crest windows its
// Browsers show in, and the views beside each page. The binding keeps the
// Browsers themselves.
class LinuxShell final : public crest::EngineBinding::Shell {
 public:
  // The core places a Browser the engine creates for itself
  // (chrome.windows.create, an app window), over the windows as the person
  // last used them, as the Mac's shell asks it: the window in use, or a new
  // one the core names.
  std::optional<crest::EngineBinding::WindowPlacement> ReserveWindow(const std::string& profile,
                                                                      bool own_window) override {
    crest::CoreHost* host = crest::CoreHost::Get();
    if (!host || State().quitting) return std::nullopt;
    const auto place = host->PlaceEngineWindow(profile, own_window, crest::LinuxWindow::Stacked());
    if (!place) return std::nullopt;
    return crest::EngineBinding::WindowPlacement{.window = place->window, .space = place->space};
  }

  // An open window shows the Space its new tabs join. A window the core
  // named for them opens on that Space, and they wait until its WebUI has
  // opened it in the core, which refuses tabs for a window that is not open.
  bool PresentWindow(const crest::EngineBinding::WindowPlacement& placement, bool focused) override {
    if (State().quitting) return true;
    if (crest::LinuxWindow* window = crest::LinuxWindow::Find(placement.window)) {
      crest::ShowSpace(*window, placement.space);
      if (focused) window->Present();
      return true;
    }
    if (!State().ui_profile) return true;
    crest::LinuxWindow::Open(State().ui_profile, crest::LinuxWindow::Kind::kBrowser, placement.window,
                             "window=" + base::ToLowerASCII(placement.window) +
                                 "&space=" + base::ToLowerASCII(placement.space),
                             focused);
    return false;
  }

  // The page's extension popup and side panel go before the page itself.
  void ReleasePage(const std::string& page) override {
    crest::ReleaseExtensionViews(page);
    crest::LinuxWindow::ReleaseEverywhere(page);
  }

  // A docked inspector fills the card of the page it inspects, in whichever
  // window shows that page; undocked, it keeps Chromium's own DevTools window.
  void DockInspector(const std::string& page, content::WebContents* frontend) override {
    crest::LinuxWindow::DockInspector(page, frontend);
  }

  // A popup opened with no page may be anchored in the profile being let go of.
  void ReleaseProfile(const std::string& profile) override { crest::ReleaseSpaceExtensionPopup(); }
  void RetractSidePanels(Profile* profile, const std::string& extension_id, std::optional<int> tab_id) override {
    crest::RetractExtensionSidePanels(profile, extension_id, tab_id);
  }
};

base::FilePath StorageDirectory(Profile* profile) {
  // Beside Chromium's profiles, in the user data directory the launch names.
  return profile->GetPath().DirName().Append("Crest");
}

// The rows Crest puts in a context menu over one of its pages, and the
// engine's rows that copy an address, which Crest runs itself: every address
// that leaves Crest is the core's clean copy (Super Copy). The WebUI holds the
// core's codec, so each row runs there.
class PageMenuRows final : public RenderViewContextMenuObserver {
 public:
  // `page` is the page's binding key; `selection` is empty when the menu
  // offers no search.
  PageMenuRows(std::string page, std::u16string selection, GURL link, GURL source)
      : page_(std::move(page)), selection_(std::move(selection)), link_(std::move(link)), source_(std::move(source)) {}

  // RenderViewContextMenuObserver:
  bool IsCommandIdSupported(int command_id) override {
    switch (command_id) {
      case IDC_CONTENT_CONTEXT_SEARCHWEBFOR:
        return !selection_.empty();
      case IDC_CONTENT_CONTEXT_COPYLINKLOCATION:
      case IDC_CONTENT_CONTEXT_COPYIMAGELOCATION:
      case IDC_CONTENT_CONTEXT_COPYAVLOCATION:
        return true;
      default:
        return false;
    }
  }

  bool IsCommandIdEnabled(int command_id) override {
    switch (command_id) {
      case IDC_CONTENT_CONTEXT_COPYLINKLOCATION:
        return link_.is_valid();
      case IDC_CONTENT_CONTEXT_COPYIMAGELOCATION:
      case IDC_CONTENT_CONTEXT_COPYAVLOCATION:
        return source_.is_valid();
      default:
        return true;
    }
  }

  void ExecuteCommand(int command_id) override {
    switch (command_id) {
      case IDC_CONTENT_CONTEXT_SEARCHWEBFOR:
        crest::SearchSelection(page_, selection_);
        break;
      case IDC_CONTENT_CONTEXT_COPYLINKLOCATION:
        crest::CopyLink(page_, link_);
        break;
      case IDC_CONTENT_CONTEXT_COPYIMAGELOCATION:
      case IDC_CONTENT_CONTEXT_COPYAVLOCATION:
        crest::CopyLink(page_, source_);
        break;
    }
  }

 private:
  const std::string page_;
  const std::u16string selection_;
  const GURL link_;
  const GURL source_;
};

}  // namespace

namespace crest {

LinuxUI* GetLinuxUI() {
  return State().ui;
}

void SetLinuxUI(LinuxUI* ui) {
  State().ui = ui;
}

bool IsEnabled() {
  static const bool enabled = base::CommandLine::ForCurrentProcess()->HasSwitch("crest-control-plane");
  return enabled;
}

void EnsureCrestUIStarted(Browser* browser) {
  auto& state = State();
  if (state.started) return;
  state.started = true;
  static base::NoDestructor<LinuxShell> shell;
  EngineBinding::Get().SetShell(shell.get());
  std::string error;
  if (!CoreHost::Start(StorageDirectory(browser->GetProfile()), &error)) {
    // The window still opens; its sidebar says the core is not running.
    LOG(ERROR) << error;
  }
  RegisterCrestUI();
  state.ui_profile = browser->GetProfile();
  // The frames the browser windows kept, which the windows the launch
  // reopens come back at.
  LinuxWindow::LoadFrames(StorageDirectory(browser->GetProfile()).Append("WindowFrames.json"));
  // The launch's first window, whose WebUI opens the rest the core reopens.
  LinuxWindow::Open(browser->GetProfile(), LinuxWindow::Kind::kBrowser, std::string(), std::string(),
                    /*activates=*/true);
}

void CrestWindowClosed() {
  auto& state = State();
  if (state.disposing || LinuxWindow::AnyBrowsing()) return;
  state.disposing = true;
  state.quitting = true;
  // Quick Windows go with the last browser window, as a quit closes them.
  LinuxWindow::CloseAll();
  // The core has stopped accepting work: the binding lets every page go,
  // closes its Browsers and releases the profiles, then the core saves and
  // closes its session file.
  EngineBinding::Get().Dispose();
  if (CoreHost* host = CoreHost::Get()) host->Shutdown();
  chrome::AttemptUserExit();
}

// Whether the platform is hosting Crest is the shell's to say: before Crest's
// UI runs, and once it is shutting down, the engine's own answer stands.
// Otherwise the binding decides, since it keeps the Browsers.
bool CanCreateEngineBrowser(Profile* profile) {
  if (!IsEnabled() || !State().started || State().disposing || State().quitting) return true;
  return EngineBinding::Get().Browsers().MayCreate(profile);
}

views::Widget* WindowForBrowser(const Browser* browser) {
  if (!State().started) return nullptr;
  const std::string kept_for = EngineBinding::Get().Browsers().WindowOf(browser);
  LinuxWindow* window = kept_for.empty() ? LinuxWindow::Active() : LinuxWindow::Find(kept_for);
  return window ? window->widget() : nullptr;
}

void WindowAdopted(const std::string& window) {
  if (!State().disposing) EngineBinding::Get().Browsers().WindowOpened(window);
}

// TODO(linux): the browser hands a second launch's links to the running
// one through StartupBrowserCreator, which no Linux patch routes here yet.
bool OpenExternalURLs(const std::vector<std::string>& urls) {
  if (!IsEnabled() || !State().started || State().disposing) return false;
  LinuxWindow* window = LinuxWindow::Active();
  return window && OpenExternalLinks(*window, urls);
}

// TODO(linux): Crest's quit preparation (downloads, unsaved pages) asks
// through Crest's own dialogs, which the Linux shell does not draw yet.
bool DeferQuit() {
  return IsEnabled() && State().started && !State().quitting && State().ui && State().ui->DeferQuit();
}

bool Reopen() {
  if (!IsEnabled() || !State().started || State().disposing || State().quitting || !State().ui) return false;
  return State().ui->Reopen();
}

// A page the core asked whether it may close answers the core.
bool CompletePageClosePreparation(content::WebContents* contents, bool proceed) {
  return AnswerBeforeUnload(contents, proceed);
}

// Picture in Picture keeps the window manager's placement on Linux.
void SnapPictureInPictureWindow(views::Widget* window) {}

// TODO(linux): Crest's own link drag (a link dropped on the sidebar becomes a
// tab) follows once the sidebar takes drops. Chromium's drag goes on.
bool BeginLinkDrag(content::WebContents* contents, const content::DropData& data) {
  return false;
}

std::unique_ptr<RenderViewContextMenuObserver> AdaptPageMenu(content::WebContents& contents,
                                                             const content::ContextMenuParams& params,
                                                             ui::SimpleMenuModel& menu) {
  if (!IsEnabled()) return nullptr;
  // These destinations require Chrome profile/Views UI. Crest owns Space and
  // window routing; never expose an engine-only window or profile here.
  for (size_t i = menu.GetItemCount(); i > 0; --i) {
    const int command = menu.GetCommandIdAt(i - 1);
    // "Open link as <profile>" rows, one per other Chromium profile, take the
    // IDs from IDC_OPEN_LINK_IN_PROFILE_FIRST up to the next block's.
    if (command >= IDC_OPEN_LINK_IN_PROFILE_FIRST && command < IDC_CONTENT_CONTEXT_START_SMART_SELECTION_ACTION1) {
      menu.RemoveItemAt(i - 1);
      continue;
    }
    switch (command) {
      case IDC_CONTENT_CONTEXT_OPENLINKNEWWINDOW:
      case IDC_CONTENT_CONTEXT_OPENLINKOFFTHERECORD:
      case IDC_CONTENT_CONTEXT_OPENLINKINPROFILE:
      case IDC_CONTENT_CONTEXT_OPENLINKBOOKMARKAPP:
      case IDC_CONTENT_CONTEXT_OPENLINKSPLITVIEW:
      // These open Views surfaces this build never creates, or depend on a
      // default search engine and sync the product does not have.
      case IDC_CONTENT_CONTEXT_GENERATE_QR_CODE:
      case IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE:
      case IDC_CONTENT_CONTEXT_LISTEN_TO_THIS_PAGE:
      case IDC_CONTENT_CONTEXT_SEARCHWEBFOR:
      case IDC_SEND_TAB_TO_SELF:
        menu.RemoveItemAt(i - 1);
        break;
    }
  }
  // Removing items can leave separators doubled or at either end.
  for (size_t i = menu.GetItemCount(); i > 0; --i) {
    const size_t index = i - 1;
    if (menu.GetTypeAt(index) != ui::MenuModel::TYPE_SEPARATOR) continue;
    const bool at_edge = index == 0 || index + 1 == menu.GetItemCount();
    const bool doubled = index + 1 < menu.GetItemCount() && menu.GetTypeAt(index + 1) == ui::MenuModel::TYPE_SEPARATOR;
    if (at_edge || doubled) menu.RemoveItemAt(index);
  }

  // Crest's rows for the selection go ahead of the engine's, with a separator
  // between. A page Crest does not show, or one that is going, has none.
  EnginePage* page = State().disposing ? nullptr : EngineBinding::Get().PageFor(&contents);
  const std::string key = page ? page->key() : std::string();
  const std::u16string selection(base::TrimWhitespace(params.selection_text, base::TRIM_ALL));
  const std::u16string engine = selection.empty() ? std::u16string() : SelectionSearchEngine(key);
  if (!engine.empty()) {
    menu.InsertItemAt(0, IDC_CONTENT_CONTEXT_SEARCHWEBFOR, u"Search with " + engine);
    if (menu.GetItemCount() > 1) menu.InsertSeparatorAt(1, ui::NORMAL_SEPARATOR);
  }
  VLOG(1) << "Crest's rows join a context menu of " << menu.GetItemCount() << " rows over page " << key;
  return std::make_unique<PageMenuRows>(key, engine.empty() ? std::u16string() : selection,
                                        params.unfiltered_link_url, params.src_url);
}

void AddNavigationThrottle(content::NavigationThrottleRegistry& registry) {
  if (!IsEnabled()) return;
  registry.AddThrottle(EngineBinding::LinkThrottle(registry));
}

// `chrome.action.openPopup()` opens over the page `browser` shows, from the
// extension's control in the window's sidebar (crest_extensions_linux).
bool OpenExtensionActionPopup(BrowserWindowInterface& browser, const extensions::Extension& extension,
                              base::OnceCallback<void(extensions::ExtensionHost*)> shown) {
  if (!IsEnabled() || !State().started || State().disposing || State().quitting) return false;
  return OpenExtensionPopupFromEngine(browser, extension, std::move(shown));
}

// Crest's own installs ask the core through the prompt they install with and
// never come here. Any other install has no review in Crest to answer it, and
// Crest's review is the only consent an install in its windows gets, so it
// is declined, as the Mac host declines one it cannot place.
// TODO(linux): the Mac host asks the engine's other prompts (an extension
// that needs more permissions to be enabled again, one opened from outside
// a Crest window) in a native sheet; Linux declines them until its WebUI
// draws one.
void ShowExtensionPrompt(std::unique_ptr<ExtensionInstallPromptShowParams> params,
                         ExtensionInstallPrompt::DoneCallback callback,
                         std::unique_ptr<extensions::InstallPromptData> prompt) {
  using Result = extensions::ExtensionInstallPromptClient::Result;
  using Payload = ExtensionInstallPrompt::DoneCallbackPayload;
  std::move(callback).Run(Payload(Result::ABORTED));
}

std::unique_ptr<permissions::PermissionPrompt> CreatePermissionPrompt(
    content::WebContents* contents, permissions::PermissionPrompt::Delegate* delegate) {
  if (delegate->ShouldDropCurrentRequestIfCannotShowQuietly()) return nullptr;
  // Requests raised again while they take an answer already have it; see
  // AnswerPermissionRequests.
  if (State().answering_permission == delegate) return nullptr;
  // A request Crest's permission record covers is asked through the page, so
  // the decision is recorded per Space and listed in Privacy.
  // TODO(linux): the Mac host asks any other request in a native sheet.
  return EngineBinding::Get().PermissionPrompt(contents, delegate);
}

void AnswerPermissionRequests(permissions::PermissionPrompt::Delegate& delegate, bool grants, bool remembers) {
  base::AutoReset<raw_ptr<const permissions::PermissionPrompt::Delegate>> answering(
      &State().answering_permission, &delegate);
  // Chromium allows several downloads only for good: its download request
  // refuses an answer for this time alone.
  const bool downloads = std::ranges::any_of(delegate.Requests(), [](const auto& request) {
    return request->request_type() == permissions::RequestType::kMultipleDownloads;
  });
  if (grants && downloads && !remembers) {
    // The downloads waiting go ahead; the grant Chromium saved comes back
    // out, so the site asks again next time, as the person chose.
    std::vector<GURL> origins;
    for (const auto& request : delegate.Requests()) {
      if (request->request_type() == permissions::RequestType::kMultipleDownloads) {
        origins.push_back(request->requesting_origin());
      }
    }
    content::WebContents* contents = delegate.GetAssociatedWebContents();
    HostContentSettingsMap* settings =
        contents ? HostContentSettingsMapFactory::GetForProfile(
                       Profile::FromBrowserContext(contents->GetBrowserContext()))
                 : nullptr;
    delegate.Accept(std::monostate());
    if (settings) {
      for (const GURL& origin : origins) {
        settings->SetContentSettingDefaultScope(origin, GURL(), ContentSettingsType::AUTOMATIC_DOWNLOADS,
                                                CONTENT_SETTING_DEFAULT);
      }
    }
  } else if (grants && (remembers || downloads)) {
    delegate.Accept(std::monostate());
  } else if (grants) {
    delegate.AcceptThisTime(std::monostate());
  } else if (remembers) {
    delegate.Deny(std::monostate());
  } else {
    delegate.Dismiss(std::monostate());
  }
}

void TranslateSelection(const std::u16string& text) {
  if (!IsEnabled() || !State().started || State().disposing || text.empty() || !State().ui) return;
  State().ui->TranslateText(text);
}

void ShowEngineNotice(const std::u16string& message, ToastId toast) {
  if (!IsEnabled() || !State().started || State().disposing || message.empty() || !State().ui) return;
  State().ui->ShowEngineNotice(message, toast == ToastId::kLinkCopied ? EngineNoticeKind::kLinkCopied
                                                                      : EngineNoticeKind::kConfirmation);
}

}  // namespace crest
