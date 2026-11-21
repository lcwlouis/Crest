// Crest's host on Linux: the hooks crest_chrome_host.mm implements for the
// Mac, over a shell Chromium draws itself. The Mac host hands the engine
// binding to Crest's Swift UI, which creates the core; here the browser
// process creates the core (CoreHost) and opens Crest's window (LinuxWindow),
// whose sidebar is the chrome://crest WebUI.
//
// This is the first step of the Linux shell. Hooks whose Mac behavior needs a
// Crest UI that Linux does not draw yet keep Chromium's own behavior or
// decline, and say so where they do.

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/auto_reset.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "chrome/app/chrome_command_ids.h"
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
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "chrome/browser/ui/crest/crest_permission_prompt.h"
#include "chrome/browser/ui/crest/crest_webui_linux.h"
#include "chrome/browser/ui/toasts/api/toast_id.h"
#include "components/permissions/permission_request.h"
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
  // TODO(linux): a Browser the engine creates for itself (chrome.windows.create,
  // an app window) joins the window the person is using, as on the Mac. Until
  // the Linux window answers for its Spaces, no Space hosts one.
  std::optional<crest::EngineBinding::WindowPlacement> ReserveWindow(const std::string& profile,
                                                                      bool own_window) override {
    return std::nullopt;
  }

  void PresentWindow(const crest::EngineBinding::WindowPlacement& placement, bool focused) override {}

  void ReleasePage(const std::string& page) override {
    if (crest::LinuxWindow* window = crest::LinuxWindow::Current()) window->ReleasePage(page);
  }

  // TODO(linux): docked DevTools, extension side panels and popups live in
  // the page's card, which the Linux window does not draw yet.
  void DockInspector(const std::string& page, content::WebContents* frontend) override {}
  void ReleaseProfile(const std::string& profile) override {}
  void RetractSidePanels(Profile* profile, const std::string& extension_id, std::optional<int> tab_id) override {}
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
        crest::CopyLink(link_);
        break;
      case IDC_CONTENT_CONTEXT_COPYIMAGELOCATION:
      case IDC_CONTENT_CONTEXT_COPYAVLOCATION:
        crest::CopyLink(source_);
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
  LinuxWindow::Open(browser->GetProfile());
}

void CrestWindowClosed() {
  auto& state = State();
  if (state.disposing) return;
  state.disposing = true;
  state.quitting = true;
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
  // Crest on Linux has one window so far; every Browser shows in it.
  LinuxWindow* window = LinuxWindow::Current();
  return window ? window->widget() : nullptr;
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

// TODO(linux): extension action popups open from the extension's control in
// Crest's toolbar, which the Linux window does not draw yet.
bool OpenExtensionActionPopup(BrowserWindowInterface& browser, const extensions::Extension& extension,
                              base::OnceCallback<void(extensions::ExtensionHost*)> shown) {
  return false;
}

// Crest's own installs ask the core through the prompt they install with and
// never come here. Any other install has no review in Crest to answer it, and
// Crest's review is the only consent an install in its windows gets, so it
// is declined, as the Mac host declines one it cannot place.
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
  if (grants && remembers) {
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
