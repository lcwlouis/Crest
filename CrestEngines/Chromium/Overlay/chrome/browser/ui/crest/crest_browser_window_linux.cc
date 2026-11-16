// Adapted from Mori (MIT), commit b5b29c2e29061f9b2009e8cc0b2756c6ad62bb20.
// Copyright (c) 2026 Mori contributors. See CrestEngines/Chromium/ThirdParty/Mori-LICENSE.
// Crest BrowserWindow on Linux: mostly inert (Crest's own shell draws the
// chrome); window-level queries answer against the Crest views::Widget the
// Browser shows in. Ported from crest_browser_window.mm; keep the two in step.

#include "chrome/browser/ui/crest/crest_browser_window.h"
#include <type_traits>
static_assert(!std::is_abstract_v<CrestBrowserWindow>);


#include "base/functional/bind.h"
#include "base/location.h"
#include "chrome/browser/share/share_attempt.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/autofill/autofill_bubble_handler.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/autofill/update_address_bubble_controller.h"
#include "chrome/browser/ui/crest/crest_chrome_hooks.h"
#include "chrome/browser/ui/crest/crest_linux_ui.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_bubble.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_bubble_type.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_manager.h"
#include "chrome/browser/ui/exclusive_access/fullscreen_controller.h"
#include "chrome/browser/ui/browser_window/public/browser_window_features.h"
#include "chrome/browser/ui/unload_controller.h"
#include "chrome/browser/ui/views/bubble_anchor_util_views.h"
#include "ui/views/widget/widget_delegate.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/sharing_message/sharing_dialog_data.h"
#include "components/web_modal/modal_dialog_host.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/gfx/range/range.h"
#include "ui/views/widget/widget.h"
#include "chrome/browser/themes/theme_service.h"
#include "ui/native_theme/native_theme.h"
#include "ui/color/color_provider_manager.h"


namespace {

// How long after a page leaves the fullscreen window it showed alone in the
// window keeps its fullscreen against a held Escape: longer than Chromium waits
// for a held Escape before it ends the browser's fullscreen.
constexpr base::TimeDelta kPageEscapeHoldGuard = base::Milliseconds(2000);

// Crest's chrome shortcuts (⌘S toggle sidebar, ⌘T toggle omnibox, …) belong to
// the SwiftUI registry. Claim them here — in the browser's keyboard pre-handler
// — so they win *before* the focused web page or Chromium's own commands
// (Save Page As on ⌘S, New Tab on ⌘T) can act. This is what makes the
// shortcuts fire reliably while web content has focus, instead of racing the
// app-level NSEvent monitor and Chromium's native accelerators (the
// intermittent "needs two presses" behavior).
bool HandleCrestShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined) {
  // Only fire on the raw key-down; ignore synthesized char and key-up events.
  if (event.GetType() != input::NativeWebKeyboardEvent::Type::kRawKeyDown) {
    return false;
  }
  crest::LinuxUI* ui = crest::GetLinuxUI();
  return ui && ui->HandleShortcut(event, page_declined);
}

class CrestAutofillBubbleHandler final : public autofill::AutofillBubbleHandler {
 public:
  CrestAutofillBubbleHandler() = default;
  ~CrestAutofillBubbleHandler() override = default;

  autofill::AutofillBubbleBase* ShowSaveCreditCardBubble(
      content::WebContents* web_contents,
      autofill::SaveCardBubbleController* controller,
      bool is_user_gesture) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowIbanBubble(
      content::WebContents* web_contents,
      autofill::IbanBubbleController* controller,
      bool is_user_gesture,
      autofill::IbanBubbleType bubble_type) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowOfferNotificationBubble(
      content::WebContents* web_contents,
      autofill::OfferNotificationBubbleController* controller,
      bool is_user_gesture) override {
    Unavailable(crest::UnavailableFeature::kAutofillOffers);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowSaveAutofillAiDataBubble(
      content::WebContents* web_contents,
      autofill::AutofillAiImportDataController* controller) override {
    Unavailable(crest::UnavailableFeature::kAutofillAI);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowAutofillAiLocalSaveNotification(
      content::WebContents* web_contents,
      autofill::AutofillAiImportDataController* controller) override {
    Unavailable(crest::UnavailableFeature::kAutofillAI);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowSaveAddressProfileBubble(
      content::WebContents* web_contents,
      std::unique_ptr<autofill::SaveAddressBubbleController> controller,
      bool is_user_gesture) override {
    Unavailable(crest::UnavailableFeature::kAddressAutofill);
    return nullptr;
  }

#if BUILDFLAG(ENABLE_DICE_SUPPORT)
  autofill::AutofillBubbleBase* ShowAddressSignInPromo(
      content::WebContents* web_contents,
      const autofill::AutofillProfile& autofill_profile) override {
    Unavailable(crest::UnavailableFeature::kAddressAutofillSignIn);
    return nullptr;
  }
#endif

  autofill::AutofillBubbleBase* ShowUpdateAddressProfileBubble(
      content::WebContents* web_contents,
      std::unique_ptr<autofill::UpdateAddressBubbleController> controller,
      bool is_user_gesture) override {
    Unavailable(crest::UnavailableFeature::kAddressAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowFilledCardInformationBubble(
      content::WebContents* web_contents,
      autofill::FilledCardInformationBubbleController* controller,
      bool is_user_gesture) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowVirtualCardEnrollBubble(
      content::WebContents* web_contents,
      autofill::VirtualCardEnrollBubbleController* controller,
      bool is_user_gesture) override {
    Unavailable(crest::UnavailableFeature::kVirtualCardEnrollment);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowVirtualCardEnrollConfirmationBubble(
      content::WebContents* web_contents,
      autofill::VirtualCardEnrollBubbleController* controller) override {
    Unavailable(crest::UnavailableFeature::kVirtualCardEnrollment);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowMandatoryReauthBubble(
      content::WebContents* web_contents,
      autofill::MandatoryReauthBubbleController* controller,
      bool is_user_gesture,
      autofill::MandatoryReauthBubbleType bubble_type) override {
    Unavailable(crest::UnavailableFeature::kAutofillReauthentication);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowSaveCardConfirmationBubble(
      content::WebContents* web_contents,
      autofill::SaveCardBubbleController* controller) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowSaveIbanConfirmationBubble(
      content::WebContents* web_contents,
      autofill::IbanBubbleController* controller) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowOmniboxAutofillBubble(
      content::WebContents*, autofill::OmniboxAutofillBubbleController*) override {
    Unavailable(crest::UnavailableFeature::kAutofill);
    return nullptr;
  }
  autofill::AutofillBubbleBase* ShowPaymentsChurnedUsersBubble(
      content::WebContents*, autofill::PaymentsChurnedUsersBubbleController*, bool) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowPaymentsChurnedUsersConfirmationBubble(
      content::WebContents*, autofill::PaymentsChurnedUsersBubbleController*) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }

  autofill::AutofillBubbleBase* ShowWalletReminderNoticeBubble(
      content::WebContents*, autofill::WalletReminderNoticeBubbleController*, bool) override {
    Unavailable(crest::UnavailableFeature::kPaymentAutofill);
    return nullptr;
  }
 private:
  static void Unavailable(crest::UnavailableFeature feature) {
    if (crest::LinuxUI* ui = crest::GetLinuxUI()) {
      ui->ShowUnavailable(feature);
    }
  }
};

void ShowUnavailable(crest::UnavailableFeature feature) {
  if (crest::LinuxUI* ui = crest::GetLinuxUI()) {
    ui->ShowUnavailable(feature);
  }
}

}  // namespace

CrestBrowserWindow::CrestBrowserWindow(Browser* browser)
    : browser_(browser),
      modal_dialog_host_(browser),
      exclusive_access_context_(browser),
      location_bar_(browser) {
  crest::OnBrowserWindowCreated(browser);
}

// --- CrestFindBar --------------------------------------------------------------

FindBarController* CrestFindBar::GetFindBarController() const {
  return controller_;
}

void CrestFindBar::SetFindBarController(FindBarController* find_bar_controller) { controller_ = find_bar_controller; }

void CrestFindBar::Show(bool animate, bool focus) {}

void CrestFindBar::Hide(bool animate) {}

void CrestFindBar::SetFocusAndSelection() {}

void CrestFindBar::ClearResults( const find_in_page::FindNotificationDetails& results) {}

void CrestFindBar::StopAnimation() {}

void CrestFindBar::MoveWindowIfNecessary() {}

void CrestFindBar::SetFindTextAndSelectedRange( const std::u16string& find_text, const gfx::Range& selected_range) {}

std::u16string_view CrestFindBar::GetFindText() const {
  return {};
}

gfx::Range CrestFindBar::GetSelectedRange() const {
  return {};
}

void CrestFindBar::UpdateUIForFindResult( const find_in_page::FindNotificationDetails& result, const std::u16string& find_text) {}

void CrestFindBar::AudibleAlert() {}

bool CrestFindBar::IsFindBarVisible() const {
  return false;
}

void CrestFindBar::RestoreSavedFocus() {}

bool CrestFindBar::HasGlobalFindPasteboard() const {
  return false;
}

void CrestFindBar::UpdateFindBarForChangedWebContents() {}

bool CrestFindBar::CanPopulateFromSelectedText() {
  return false;
}

const FindBarTesting* CrestFindBar::GetFindBarTesting() const {
  return nullptr;
}

bool CrestFindBar::HasFocus() const {
  return false;
}

void CrestFindBar::CloseOverlappingBubbles() {}

views::Widget* CrestFindBar::GetHostWidget() {
  return nullptr;
}

// --- CrestLocationBar ---------------------------------------------------------

void CrestLocationBar::FocusLocation(bool is_user_initiated, bool clear_focus_if_failed) {}

void CrestLocationBar::FocusSearch() {}

// Chromium announces omnibox changes through its own location bar, which Crest
// never shows; Crest's address field speaks for itself.
void CrestLocationBar::AnnounceAlert(const std::u16string& announcement) {}

void CrestLocationBar::UpdateFocusBehavior(bool toolbar_visible) {}

void CrestLocationBar::UpdateContentSettingsIcons() {
  // Chromium reports a page's site state here — a blocked pop-up among it.
  // Crest draws that state in its own Site Controls.
  crest::UpdateSiteIndicators(browser_->tab_strip_model()->GetActiveWebContents());
}

void CrestLocationBar::SaveStateToContents(content::WebContents* contents) {}

void CrestLocationBar::Revert() {}

OmniboxView* CrestLocationBar::GetOmniboxView() {
  return nullptr;
}

OmniboxPopupView* CrestLocationBar::GetOmniboxPopupView() {
  return nullptr;
}

OmniboxController* CrestLocationBar::GetOmniboxController() {
  return nullptr;
}

bool CrestLocationBar::ShouldCloseOmniboxPopup(ui::MouseEvent* event) {
  return false;
}

content::WebContents* CrestLocationBar::GetWebContents() {
  return nullptr;
}

LocationBarModel* CrestLocationBar::GetLocationBarModel() {
  return nullptr;
}

std::optional<bubble_anchor_util::AnchorConfiguration> CrestLocationBar::GetChipAnchor() {
  return {};
}

ChipController* CrestLocationBar::GetChipController() {
  return nullptr;
}

void CrestLocationBar::OnChanged() {}

void CrestLocationBar::UpdateWithoutTabRestore() {}

ui::TrackedElement* CrestLocationBar::GetAnchorOrNull() {
  return nullptr;
}

Browser* CrestLocationBar::GetBrowser() {
  return browser_;
}

Profile* CrestLocationBar::GetProfile() {
  return browser_ ? browser_->GetProfile() : nullptr;
}

bool CrestLocationBar::IsInitialized() const {
  return false;
}

bool CrestLocationBar::IsVisible() const {
  return false;
}

bool CrestLocationBar::IsDrawn() const {
  return false;
}

bool CrestLocationBar::IsFullscreen() const {
  return false;
}

bool CrestLocationBar::IsEditingOrEmpty() const {
  return false;
}

void CrestLocationBar::InvalidateLayout() {}

gfx::Rect CrestLocationBar::Bounds() const {
  return {};
}

gfx::Rect CrestLocationBar::BoundsInScreen() const {
  return {};
}

gfx::Size CrestLocationBar::MinimumSize() const {
  return {};
}

gfx::Size CrestLocationBar::PreferredSize() const {
  return {};
}

void CrestLocationBar::Update(content::WebContents* contents) {}

void CrestLocationBar::ResetTabState(content::WebContents* contents) {}

bool CrestLocationBar::HasSecurityStateChanged() {
  return false;
}

LocationBarTesting* CrestLocationBar::GetLocationBarForTesting() {
  return nullptr;
}

// --- CrestExclusiveAccessContext ---------------------------------------------

CrestExclusiveAccessContext::CrestExclusiveAccessContext(Browser* browser)
    : browser_(browser) {}

CrestExclusiveAccessContext::~CrestExclusiveAccessContext() {
  HideFullscreenDisclosure(ExclusiveAccessBubbleHideReason::kInterrupted);
}

Profile* CrestExclusiveAccessContext::GetProfile() {
  return browser_->GetProfile();
}

bool CrestExclusiveAccessContext::IsFullscreen() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsFullscreen();
}

void CrestExclusiveAccessContext::EnterFullscreen(
    const url::Origin& origin,
    ExclusiveAccessBubbleType bubble_type,
    FullscreenTabParams fullscreen_tab_params) {
  // Only a page's own request shows the page alone. The browser's or an
  // extension's fullscreen keeps Crest's chrome around the page.
  content::WebContents* contents = GetWebContentsForExclusiveAccess();
  if (contents && !exclusive_access_bubble::IsExclusiveAccessModeBrowserFullscreen(bubble_type)) {
    content_fullscreen_ = contents->GetWeakPtr();
    crest::ReportContentFullscreen(contents, true);
  }
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (window && !window->IsFullscreen()) {
    // The disclosure shows once the window is fullscreen, where it belongs.
    window->SetFullscreen(true);
    return;
  }
  UpdateExclusiveAccessBubble({.origin = origin, .type = bubble_type}, {});
}

void CrestExclusiveAccessContext::ExitFullscreen() {
  EndContentFullscreen();
  HideFullscreenDisclosure(ExclusiveAccessBubbleHideReason::kInterrupted);
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (window && window->IsFullscreen()) {
    window->SetFullscreen(false);
  }
}

void CrestExclusiveAccessContext::WindowFullscreenChanged(bool entered) {
  // Chromium's own windows report every transition, as the fullscreen
  // controller expects: entering shows its disclosure, and leaving ends the
  // page's fullscreen however the window left.
  ExclusiveAccessManager::From(browser_)
      ->fullscreen_controller()
      ->WindowFullscreenStateChanged();
  if (!entered) {
    EndContentFullscreen();
  }
}

void CrestExclusiveAccessContext::UpdateUIForTabFullscreen() {
  // A page's fullscreen in a window that is already fullscreen neither enters
  // nor leaves the window's fullscreen: Chromium only updates the window's UI,
  // as its own windows hide their toolbar. The page shows alone while it holds
  // the window's exclusive access, and goes back among Crest's chrome when it
  // lets go, leaving the window fullscreen as it was.
  content::WebContents* contents = GetWebContentsForExclusiveAccess();
  FullscreenController* controller =
      ExclusiveAccessManager::From(browser_)->fullscreen_controller();
  if (contents && controller->exclusive_access_tab() == contents) {
    content_fullscreen_ = contents->GetWeakPtr();
    crest::ReportContentFullscreen(contents, true);
    return;
  }
  if (content_fullscreen_) {
    page_left_fullscreen_window_ = base::TimeTicks::Now();
  }
  EndContentFullscreen();
}

void CrestExclusiveAccessContext::EndContentFullscreen() {
  content::WebContents* contents = content_fullscreen_.get();
  content_fullscreen_.reset();
  if (contents) {
    crest::ReportContentFullscreen(contents, false);
  }
}

void CrestExclusiveAccessContext::UpdateExclusiveAccessBubble(
    const ExclusiveAccessBubbleParams& params,
    ExclusiveAccessBubbleHideCallback first_hide_callback) {
  // Crest discloses a page's fullscreen. The browser's or an extension's keeps
  // Crest's chrome and needs no instruction.
  const bool should_close_bubble =
      (!params.has_download &&
       params.type == EXCLUSIVE_ACCESS_BUBBLE_TYPE_NONE) ||
      exclusive_access_bubble::IsExclusiveAccessModeBrowserFullscreen(params.type);
  if (should_close_bubble) {
    if (first_hide_callback) {
      std::move(first_hide_callback)
          .Run(ExclusiveAccessBubbleHideReason::kNotShown);
    }
    HideFullscreenDisclosure(ExclusiveAccessBubbleHideReason::kInterrupted);
    return;
  }
  ShowFullscreenDisclosure(params.origin, std::move(first_hide_callback));
}

bool CrestExclusiveAccessContext::IsExclusiveAccessBubbleDisplayed() const {
  return exclusive_access_bubble_visible_;
}

void CrestExclusiveAccessContext::OnExclusiveAccessUserInput() {
  // The disclosure is drawn by Crest's shell over its window and stays up
  // until its timer ends.
}

content::WebContents* CrestExclusiveAccessContext::GetWebContentsForExclusiveAccess() {
  return browser_->tab_strip_model()->GetActiveWebContents();
}

bool CrestExclusiveAccessContext::CanUserEnterFullscreen() const {
  return true;
}

bool CrestExclusiveAccessContext::CanUserExitFullscreen() const {
  // The Escape that ends a page's fullscreen ends only the page's. Chromium
  // ends the browser's fullscreen when Escape is held, and a page going back
  // among Crest's chrome leaves the window for a moment, so the key's release
  // can reach the window instead of the page, and a tap would read as held.
  return base::TimeTicks::Now() - page_left_fullscreen_window_ > kPageEscapeHoldGuard;
}

void CrestExclusiveAccessContext::ShowFullscreenDisclosure(
    const url::Origin& origin,
    ExclusiveAccessBubbleHideCallback first_hide_callback) {
  // M1: the disclosure is not drawn yet. Chromium's fullscreen still runs
  // its timers and Escape handling against this context.
  if (!crest::WindowForBrowser(browser_)) {
    if (first_hide_callback) {
      std::move(first_hide_callback)
          .Run(ExclusiveAccessBubbleHideReason::kNotShown);
    }
    return;
  }

  HideFullscreenDisclosure(ExclusiveAccessBubbleHideReason::kInterrupted);
  fullscreen_disclosure_hide_callback_ = std::move(first_hide_callback);
  exclusive_access_bubble_visible_ = true;
  fullscreen_disclosure_timer_.Start(
      FROM_HERE, ExclusiveAccessBubble::kShowTime,
      base::BindOnce(&CrestExclusiveAccessContext::HideFullscreenDisclosure,
                     base::Unretained(this),
                     ExclusiveAccessBubbleHideReason::kTimeout));
}

void CrestExclusiveAccessContext::HideFullscreenDisclosure(
    ExclusiveAccessBubbleHideReason reason) {
  fullscreen_disclosure_timer_.Stop();
  exclusive_access_bubble_visible_ = false;

  if (fullscreen_disclosure_hide_callback_) {
    std::move(fullscreen_disclosure_hide_callback_).Run(reason);
  }
}

CrestBrowserWindow::~CrestBrowserWindow() {
  crest::OnBrowserWindowDestroyed(browser_);
}

// --- CrestModalDialogHost ----------------------------------------------------

CrestModalDialogHost::~CrestModalDialogHost() {
  for (auto& observer : observers_) {
    observer.OnHostDestroying();
  }
}

gfx::NativeView CrestModalDialogHost::GetHostView() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window ? window->GetNativeView() : gfx::NativeView();
}

gfx::Point CrestModalDialogHost::GetDialogPosition(const gfx::Size& size) {
  views::Widget* window = crest::WindowForBrowser(browser_);
  const int width = window ? window->GetClientAreaBoundsInScreen().width() : 1280;
  return gfx::Point(std::max(0, (width - size.width()) / 2), 64);
}

gfx::Size CrestModalDialogHost::GetMaximumDialogSize() {
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (!window) {
    return gfx::Size(1200, 760);
  }
  return window->GetClientAreaBoundsInScreen().size();
}

void CrestModalDialogHost::AddObserver(
    web_modal::ModalDialogHostObserver* observer) {
  observers_.AddObserver(observer);
}

void CrestModalDialogHost::RemoveObserver(
    web_modal::ModalDialogHostObserver* observer) {
  observers_.RemoveObserver(observer);
}

bool CrestBrowserWindow::IsMaximized() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsMaximized();
}

bool CrestBrowserWindow::IsMinimized() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsMinimized();
}

bool CrestBrowserWindow::IsFullscreen() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsFullscreen();
}

// An extension's popup that shows as a tab leaves the person's window alone.
void CrestBrowserWindow::Hide() {
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (window && crest::OwnsWindow(browser_)) window->Hide();
}

void CrestBrowserWindow::ShowInactive() {
  crest::OnEngineWindowShown(browser_, false);
  if (views::Widget* window = crest::WindowForBrowser(browser_)) window->ShowInactive();
}

void CrestBrowserWindow::Deactivate() {}

void CrestBrowserWindow::Maximize() {
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (window && crest::OwnsWindow(browser_) && !IsMaximized()) window->Maximize();
}

void CrestBrowserWindow::Minimize() {
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (window && crest::OwnsWindow(browser_)) window->Minimize();
}

void CrestBrowserWindow::Restore() {
  if (!crest::OwnsWindow(browser_)) return;
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (window && (window->IsMinimized() || window->IsMaximized())) window->Restore();
}

void CrestBrowserWindow::FlashFrame(bool flash) {}

ui::ZOrderLevel CrestBrowserWindow::GetZOrderLevel() const {
  return ui::ZOrderLevel::kNormal;
}

void CrestBrowserWindow::SetZOrderLevel(ui::ZOrderLevel order) {}

bool CrestBrowserWindow::IsOnCurrentWorkspace() const {
  return true;
}

bool CrestBrowserWindow::IsVisibleOnScreen() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsVisibleOnScreen();
}

void CrestBrowserWindow::SetTopControlsShownRatio(content::WebContents* web_contents, float ratio) {}

bool CrestBrowserWindow::DoBrowserControlsShrinkRendererSize( const content::WebContents* contents) const {
  return false;
}

ui::NativeTheme* CrestBrowserWindow::GetNativeTheme() {
  return ui::NativeTheme::GetInstanceForNativeUi();
}

const ui::ThemeProvider* CrestBrowserWindow::GetThemeProvider() const {
  return &ThemeService::GetThemeProviderForProfile(browser_->GetProfile());
}

const ui::ColorProvider* CrestBrowserWindow::GetColorProvider() const {
  return ui::ColorProviderManager::Get().GetColorProviderFor(
      ui::NativeTheme::GetInstanceForNativeUi()->GetColorProviderKey(nullptr, false));
}

int CrestBrowserWindow::GetTopControlsHeight() const {
  return {};
}

void CrestBrowserWindow::SetTopControlsGestureScrollInProgress(bool in_progress) {}

std::vector<StatusBubble*> CrestBrowserWindow::GetStatusBubbles() {
  return {};
}

void CrestBrowserWindow::UpdateTitleBar() {}

void CrestBrowserWindow::UpdateLoadingAnimations(bool is_visible) {}




void CrestBrowserWindow::OnActiveTabChanged(content::WebContents* old_contents, content::WebContents* new_contents, int index, int reason) {}

void CrestBrowserWindow::OnTabDetached(content::WebContents* contents, bool was_active) {}

gfx::Size CrestBrowserWindow::GetContentsSize() const {
  return {};
}

void CrestBrowserWindow::SetContentsSize(const gfx::Size& size) {}

autofill::AutofillBubbleHandler* CrestBrowserWindow::GetAutofillBubbleHandler() {
  static CrestAutofillBubbleHandler* handler = new CrestAutofillBubbleHandler();
  return handler;
}

LocationBar* CrestBrowserWindow::GetLocationBar() const {
  return const_cast<CrestLocationBar*>(&location_bar_);
}

// Crest's menus are its own, so no Chromium menu asks this window for its
// command shortcuts.
ui::AcceleratorProvider* CrestBrowserWindow::GetAcceleratorProvider() {
  return nullptr;
}

// Crest's toolbar is its own, so this window pins no Chromium toolbar actions.
PinnedToolbarActions* CrestBrowserWindow::GetPinnedToolbarActions() {
  return nullptr;
}

void CrestBrowserWindow::SetFocusToLocationBar(bool is_user_initiated) {
  if (crest::LinuxUI* ui = crest::GetLinuxUI()) ui->FocusLocation();
}

void CrestBrowserWindow::UpdateReloadStopState(bool is_loading, bool force) {}

void CrestBrowserWindow::UpdateToolbar(content::WebContents* contents) {}

bool CrestBrowserWindow::UpdateToolbarSecurityState() {
  return false;
}

void CrestBrowserWindow::UpdateCustomTabBarVisibility(bool visible, bool animate) {}

// Chrome dims its contents view while a DevTools-owned modal dialog is up. The
// dialog is presented as a sheet on the Crest window, which draws its own
// dimming, so there is no separate scrim to show or hide.

void CrestBrowserWindow::ResetToolbarTabState(content::WebContents* contents) {}

void CrestBrowserWindow::FocusToolbar() {}

void CrestBrowserWindow::ToolbarSizeChanged(bool is_animating) {}

void CrestBrowserWindow::TabDraggingStatusChanged(bool is_dragging) {}

void CrestBrowserWindow::LinkOpeningFromGesture(WindowOpenDisposition disposition) {}

void CrestBrowserWindow::FocusAppMenu() {}

bool CrestBrowserWindow::IsTabStripEditable() const {
  return true;
}

void CrestBrowserWindow::DisableTabStripEditingForTesting() {}

bool CrestBrowserWindow::IsToolbarVisible() const {
  return false;
}

bool CrestBrowserWindow::IsToolbarShowing() const {
  return false;
}

bool CrestBrowserWindow::IsLocationBarVisible() const {
  return false;
}

void CrestBrowserWindow::ShowUpdateChromeDialog() {}

void CrestBrowserWindow::ShowIntentPickerBubble( std::vector<apps::IntentPickerAppInfo> app_info, bool show_stay_in_chrome, bool show_remember_selection, apps::IntentPickerBubbleType bubble_type, const std::optional<url::Origin>& initiating_origin, IntentPickerResponse callback) {
  // Linux has no app-link handoff yet; the link stays in Crest.
  std::move(callback).Run(std::string(), apps::PickerEntryType::kUnknown,
                          apps::IntentPickerCloseReason::STAY_IN_CHROME,
                          false);
}

// Crest keeps a page by pinning its tab, so bookmarking is that.
void CrestBrowserWindow::ShowBookmarkBubble(const GURL& url, bool already_bookmarked) {
  if (crest::LinuxUI* ui = crest::GetLinuxUI()) ui->BookmarkActivePage();
}

ShowTranslateBubbleResult CrestBrowserWindow::ShowTranslateBubble( content::WebContents* contents, translate::TranslateStep step, const std::string& source_language, const std::string& target_language, translate::TranslateErrors error_type, bool is_user_gesture) {
  if (contents) {
    if (crest::LinuxUI* ui = crest::GetLinuxUI()) ui->TranslatePage();
  }
  return {};
}

DownloadBubbleUIController* CrestBrowserWindow::GetDownloadBubbleUIController() {
  return nullptr;
}

void CrestBrowserWindow::ConfirmBrowserCloseWithPendingDownloads( int download_count, DownloadCloseType dialog_type, base::OnceCallback<void(bool)> callback) {
  // TODO(linux): ask in Crest's own dialog, as the Mac shell's alert does.
  std::move(callback).Run(true);
}

void CrestBrowserWindow::ShowAppMenu() {
}

void CrestBrowserWindow::PreHandleDragUpdate(const content::DropData& drop_data, const gfx::PointF& point) {}

void CrestBrowserWindow::PreHandleDragExit() {}

void CrestBrowserWindow::HandleDragEnded() {}

content::KeyboardEventProcessingResult CrestBrowserWindow::PreHandleKeyboardEvent( const input::NativeWebKeyboardEvent& event) {
  if (HandleCrestShortcut(event, /*page_declined=*/false)) {
    return content::KeyboardEventProcessingResult::HANDLED;
  }
  return content::KeyboardEventProcessingResult::NOT_HANDLED;
}

bool CrestBrowserWindow::HandleKeyboardEvent( const input::NativeWebKeyboardEvent& event) {
  // Chromium offers shortcuts to the document first; whatever it left goes
  // to Crest's own commands, as the Mac shell's main menu takes it.
  return HandleCrestShortcut(event, /*page_declined=*/true);
}

std::unique_ptr<FindBar> CrestBrowserWindow::CreateFindBar() {
  return std::make_unique<CrestFindBar>();
}

web_modal::WebContentsModalDialogHost*
CrestBrowserWindow::GetWebContentsModalDialogHost() {
  return &modal_dialog_host_;
}

web_modal::WebContentsModalDialogHost*
CrestBrowserWindow::GetWebContentsModalDialogHostFor(
    content::WebContents* web_contents) {
  return &modal_dialog_host_;
}

void CrestBrowserWindow::ShowAvatarBubbleFromAvatarButton(bool is_source_accelerator) {
  ShowUnavailable(crest::UnavailableFeature::kProfiles);
}

void CrestBrowserWindow::ShowHatsDialog( const std::string& site_id, const std::optional<std::string>& hats_histogram_name, const std::optional<uint64_t> hats_survey_ukm_id, base::OnceClosure success_callback, base::OnceClosure failure_callback, const SurveyBitsData& product_specific_bits_data, const SurveyStringData& product_specific_string_data) {}

ExclusiveAccessContext* CrestBrowserWindow::GetExclusiveAccessContext() {
  return &exclusive_access_context_;
}

std::string CrestBrowserWindow::GetWorkspace() const {
  return {};
}

bool CrestBrowserWindow::IsVisibleOnAllWorkspaces() const {
  return false;
}

void CrestBrowserWindow::ShowEmojiPanel() {}

std::unique_ptr<content::EyeDropper> CrestBrowserWindow::OpenEyeDropper( content::RenderFrameHost* frame, content::EyeDropperListener* listener) {
  ShowUnavailable(crest::UnavailableFeature::kEyeDropper);
  return {};
}

void CrestBrowserWindow::ShowCaretBrowsingDialog() {
  ShowUnavailable(crest::UnavailableFeature::kCaretBrowsing);
}

void CrestBrowserWindow::CreateTabSearchBubble() {
  if (crest::LinuxUI* ui = crest::GetLinuxUI()) ui->ShowTabSearch();
}

void CrestBrowserWindow::CloseTabSearchBubble() {}

void CrestBrowserWindow::ShowIncognitoClearBrowsingDataDialog() {
  ShowUnavailable(crest::UnavailableFeature::kPrivateBrowsing);
}

void CrestBrowserWindow::ShowIncognitoHistoryDisclaimerDialog() {
  ShowUnavailable(crest::UnavailableFeature::kPrivateBrowsing);
}

bool CrestBrowserWindow::IsUnframedModeEnabled() const {
  return false;
}

bool CrestBrowserWindow::GetCanResize() {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->widget_delegate() && window->widget_delegate()->CanResize();
}

ui::mojom::WindowShowState CrestBrowserWindow::GetWindowShowState() const {
  if (IsFullscreen()) return ui::mojom::WindowShowState::kFullscreen;
  if (IsMinimized()) return ui::mojom::WindowShowState::kMinimized;
  if (IsMaximized()) return ui::mojom::WindowShowState::kMaximized;
  return ui::mojom::WindowShowState::kNormal;
}

void CrestBrowserWindow::ShowChromeLabs() {
  ShowUnavailable(crest::UnavailableFeature::kChromeLabs);
}

BrowserView* CrestBrowserWindow::AsBrowserView() {
  return nullptr;
}

void CrestBrowserWindow::DeleteBrowserWindow() {
  delete this;
}

// --- Real implementations against the assigned native Crest window -------------------

void CrestBrowserWindow::Show() {
  crest::EnsureCrestUIStarted(browser_);
  crest::OnEngineWindowShown(browser_, true);
}

void CrestBrowserWindow::Close() {
  // The BrowserView/WebUIBrowserWindow close protocol, minus the OS window:
  // beforeunload gets a veto, then tabs close, and TabStripEmpty() re-enters
  // Close() for the empty Browser, which schedules its own deletion. It is
  // never deleted here: the unload and tab strip code that emptied it is
  // still on the stack, as it is when a page's unload finishes the close
  // `chrome.windows.remove` started.
  UnloadController::From(browser_)->OnWindowClosing();
}

bool CrestBrowserWindow::IsActive() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsActive();
}

void CrestBrowserWindow::Activate() {
  // Chromium brings a page forward by making it the Browser's active tab and
  // then asking for its window, as a Picture in Picture window's return
  // control does. Crest shows that page's own window, Space and tab instead.
  if (crest::ReturnFromPictureInPicture(browser_->tab_strip_model()->GetActiveWebContents())) {
    return;
  }
  if (views::Widget* window = crest::WindowForBrowser(browser_)) window->Activate();
}

gfx::NativeWindow CrestBrowserWindow::GetNativeWindow() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window ? window->GetNativeWindow() : gfx::NativeWindow();
}

gfx::Rect CrestBrowserWindow::GetBounds() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (!window) {
    return gfx::Rect(0, 0, 1280, 820);
  }
  return window->GetWindowBoundsInScreen();
}

gfx::Rect CrestBrowserWindow::GetRestoredBounds() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  crest::LinuxUI* ui = crest::GetLinuxUI();
  if (!window) return GetBounds();
  return ui ? ui->RestoredBounds(window) : window->GetRestoredBounds();
}

ui::mojom::WindowShowState CrestBrowserWindow::GetRestoredState() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  crest::LinuxUI* ui = crest::GetLinuxUI();
  const bool zoomed = IsFullscreen() ? (ui && window && ui->WasMaximizedBeforeFullscreen(window)) : IsMaximized();
  return zoomed ? ui::mojom::WindowShowState::kMaximized : ui::mojom::WindowShowState::kNormal;
}

bool CrestBrowserWindow::IsVisible() const {
  views::Widget* window = crest::WindowForBrowser(browser_);
  return window && window->IsVisible();
}

// Only a normal Browser places the Crest window it shows in. A popup, app,
// devtools or Picture in Picture Browser shows as a tab in the person's window
// (a page's popup, a sign-in flow's account window), so the bounds Chromium
// gives it from window.open, resizeTo or moveTo would move and resize the
// person's whole window.
void CrestBrowserWindow::SetBounds(const gfx::Rect& bounds) {
  views::Widget* window = crest::WindowForBrowser(browser_);
  if (!window || IsFullscreen() || !crest::OwnsWindow(browser_)) return;
  if (browser_->GetType() != BrowserWindowInterface::Type::TYPE_NORMAL) return;
  // Bounds Chromium saved (a restored session's, an extension's) may name a
  // place no display covers now.
  window->SetBounds(crest::LinuxWindow::OnScreen(bounds));
}

bool CrestLocationBar::IsMouseHovered() const { return false; }
bool CrestLocationBar::IsFocusWithin() const {
  // The location field lives in Crest's WebUI; its shell does not report
  // focus here yet.
  return false;
}
