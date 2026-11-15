// Crest's host on Linux: the hooks crest_chrome_host.mm implements for the
// Mac, over a shell Chromium draws itself. The Mac host hands the engine
// binding to Crest's Swift UI, which creates the core; here the browser
// process creates the core (CoreHost) and opens Crest's window (LinuxWindow),
// whose sidebar is the chrome://crest WebUI.
//
// This is the first step of the Linux shell. Hooks whose Mac behavior needs a
// Crest UI that Linux does not draw yet keep Chromium's own behavior or
// decline, and say so where they do.

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/auto_reset.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
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
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/permissions/permission_request.h"
#include "components/permissions/request_type.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/drop_data.h"
#include "url/gurl.h"
#include "extensions/common/extension.h"
#include "ui/views/widget/widget.h"

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
        origins.push_back(request->requesting_origin_url());
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
