#include "chrome/browser/ui/crest/crest_webui_linux.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/base64.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/logging.h"
#include "base/memory/ref_counted_memory.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "components/input/native_web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "chrome/browser/certificate_viewer.h"
#include "chrome/browser/platform_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/chrome_paths.h"
#include "net/base/filename_util.h"
#include "net/cert/x509_certificate.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "url/gurl.h"
#include "chrome/browser/ui/crest/crest_core_host_linux.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/ssl_status.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "content/public/browser/webui_config_map.h"
#include "content/public/common/url_constants.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/native_theme/native_theme.h"
#include "url/gurl.h"

namespace crest {

namespace {

constexpr char kUIDirectorySwitch[] = "crest-ui-dir";

base::FilePath UIDirectory() {
  const auto* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(kUIDirectorySwitch)) {
    return command_line->GetSwitchValuePath(kUIDirectorySwitch);
  }
  base::FilePath directory;
  base::PathService::Get(base::DIR_EXE, &directory);
  return directory.Append("crest_ui");
}

// The file `path` names in the UI directory, never outside it.
scoped_refptr<base::RefCountedMemory> ReadUIFile(const base::FilePath& directory, const std::string& path) {
  std::string relative = path.empty() ? "index.html" : path;
  const size_t query = relative.find_first_of("?#");
  if (query != std::string::npos) relative.resize(query);
  const base::FilePath file = directory.AppendASCII(relative);
  if (file.ReferencesParent() || !directory.IsParent(file)) return nullptr;
  std::string contents;
  if (!base::ReadFileToString(file, &contents)) return nullptr;
  return base::MakeRefCounted<base::RefCountedString>(std::move(contents));
}

std::string Encode(base::span<const uint8_t> bytes) {
  return base::Base64Encode(bytes);
}

// The key `code` names as the WebUI spells it (KeyboardEvent.key, lower case
// for characters), whatever the layout and Shift make it type: the keys
// Crest's shortcuts use.
std::string KeyName(int code) {
  if (code >= ui::VKEY_A && code <= ui::VKEY_Z) return std::string(1, static_cast<char>('a' + code - ui::VKEY_A));
  if (code >= ui::VKEY_0 && code <= ui::VKEY_9) return std::string(1, static_cast<char>('0' + code - ui::VKEY_0));
  if (code >= ui::VKEY_F1 && code <= ui::VKEY_F24) return "F" + base::NumberToString(code - ui::VKEY_F1 + 1);
  switch (code) {
    case ui::VKEY_ESCAPE: return "Escape";
    case ui::VKEY_BACK: return "Backspace";
    case ui::VKEY_DELETE: return "Delete";
    case ui::VKEY_HOME: return "Home";
    case ui::VKEY_END: return "End";
    case ui::VKEY_PRIOR: return "PageUp";
    case ui::VKEY_NEXT: return "PageDown";
    case ui::VKEY_SPACE: return " ";
    case ui::VKEY_OEM_COMMA: return ",";
    case ui::VKEY_OEM_1: return ";";
    case ui::VKEY_OEM_2: return "/";
    case ui::VKEY_OEM_3: return "`";
    case ui::VKEY_OEM_5: return "\\";
    case ui::VKEY_OEM_7: return "'";
    case ui::VKEY_LEFT: return "ArrowLeft";
    case ui::VKEY_RIGHT: return "ArrowRight";
    case ui::VKEY_UP: return "ArrowUp";
    case ui::VKEY_DOWN: return "ArrowDown";
    case ui::VKEY_TAB: return "Tab";
    case ui::VKEY_RETURN: return "Enter";
    case ui::VKEY_ESCAPE: return "Escape";
    case ui::VKEY_OEM_4: return "[";
    case ui::VKEY_OEM_6: return "]";
    case ui::VKEY_OEM_PLUS: return "=";
    case ui::VKEY_ADD: return "+";
    case ui::VKEY_OEM_MINUS:
    case ui::VKEY_SUBTRACT: return "-";
    case ui::VKEY_OEM_PERIOD: return ".";
    default: return std::string();
  }
}

// A key the WebUI performs a command for, as it registered it.
struct Shortcut {
  std::string key;
  bool ctrl = false;
  bool alt = false;
  bool meta = false;
  // Unset when the key's own character already carries Shift.
  std::optional<bool> shift;
  // Whether Crest takes it before the page sees it.
  bool reserved = false;
};

std::vector<Shortcut>& Shortcuts() {
  static base::NoDestructor<std::vector<Shortcut>> shortcuts;
  return *shortcuts;
}

// The search engine a selection on the page the window shows searches with,
// as the WebUI last named it for that page.
struct SelectionSearch {
  // The page's binding key.
  std::string page;
  std::u16string engine;
};

SelectionSearch& ShownSelectionSearch() {
  static base::NoDestructor<SelectionSearch> search;
  return *search;
}

// --- Appearance (Linux shell) -----------------------------------------------
// Settings' Appearance choice, which the Mac applies to the whole application
// (NSApp.appearance in BrowserMacAppearance): every window, menu and page
// draws light or dark with it. Here it is Chromium's process-wide preferred
// color scheme, which takes precedence over the desktop's, so Crest's WebUIs,
// the floating surfaces and every page's prefers-color-scheme follow it.

// The scheme a choice (DeviceAppearance.mode) names: none for "system", which
// follows the desktop again. Unset when `name` is no choice.
std::optional<std::optional<ui::NativeTheme::PreferredColorScheme>> ColorSchemeNamed(const std::string& name) {
  using Scheme = ui::NativeTheme::PreferredColorScheme;
  if (name == "system") return std::optional<Scheme>();
  if (name == "light") return std::optional<Scheme>(Scheme::kLight);
  if (name == "dark") return std::optional<Scheme>(Scheme::kDark);
  return std::nullopt;
}

// --- End of appearance ------------------------------------------------------

// --- Downloads (Linux shell) ------------------------------------------------
// The sidebar's Downloads list opens a finished file and shows it in its
// folder; the WebUI answers the core's DownloadDestinationAsked with a path
// found here: a free name in the Downloads folder, or the place the person
// picks in a save dialog, as the Mac's BrowserPlatformDownloadDirectory.

// The local file a download's destination, a file: URL, names; empty if none.
base::FilePath DownloadFile(const base::ListValue& args) {
  base::FilePath path;
  if (args.size() != 1 || !args[0].is_string() || !net::FileURLToFilePath(GURL(args[0].GetString()), &path)) {
    return base::FilePath();
  }
  return path;
}

// `name` in the Downloads folder, made if missing, or "stem N.ext" with the
// first N no file there has, as the Mac's BrowserDownloadDestination. Empty
// when the folder is unavailable. Blocks on the disk.
base::FilePath FreeDownloadPath(const base::FilePath& name) {
  base::FilePath folder;
  if (!base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &folder) || !base::CreateDirectory(folder)) {
    return base::FilePath();
  }
  base::FilePath candidate = folder.Append(name);
  const base::FilePath::StringType stem = name.RemoveFinalExtension().value();
  const base::FilePath::StringType extension = name.FinalExtension();
  for (int suffix = 1; base::PathExists(candidate); ++suffix) {
    candidate = folder.Append(stem + " " + base::NumberToString(suffix) + extension);
  }
  return candidate;
}

// The save dialog for one download, which deletes itself once answered, as
// Chromium's DownloadFilePicker. Answers the path, or none when the person
// cancels; `unavailable` when no dialog can be shown. A dialog whose question
// the core settles first (the download cancelled, its page closed) is closed
// by its key, as the Mac's BrowserPromptDismissal closes its panel.
class DownloadSaveDialog final : public ui::SelectFileDialog::Listener {
 public:
  using Answer = base::OnceCallback<void(base::FilePath path, bool unavailable)>;

  static void Show(content::WebContents* contents,
                   const std::string& key,
                   const base::FilePath& suggested,
                   Answer answer) {
    Close(key);
    auto* listener = new DownloadSaveDialog(key, std::move(answer));
    Open()[key] = listener;
    listener->dialog_ = ui::SelectFileDialog::Create(listener, nullptr);
    if (!listener->dialog_) {
      listener->Finish(base::FilePath(), true);
      return;
    }
    listener->dialog_->SelectFile(ui::SelectFileDialog::SELECT_SAVEAS_FILE, u"Save Download", suggested,
                                  nullptr, 0, base::FilePath::StringType(), contents->GetTopLevelNativeWindow());
  }

  // Closes the dialog asked under `key`, if it is open; it answers as cancelled.
  static void Close(const std::string& key) {
    auto open = Open().find(key);
    if (open != Open().end()) open->second->Finish(base::FilePath(), false);
  }

  // ui::SelectFileDialog::Listener:
  void FileSelected(const ui::SelectedFileInfo& file, int index) override { Finish(file.path(), false); }
  void FileSelectionCanceled() override { Finish(base::FilePath(), false); }

 private:
  static std::map<std::string, DownloadSaveDialog*>& Open() {
    static base::NoDestructor<std::map<std::string, DownloadSaveDialog*>> open;
    return *open;
  }

  DownloadSaveDialog(const std::string& key, Answer answer) : key_(key), answer_(std::move(answer)) {}
  ~DownloadSaveDialog() override {
    // Unhooking the listener drops the portal's request, which closes it.
    if (dialog_) dialog_->ListenerDestroyed();
  }

  void Finish(const base::FilePath& path, bool unavailable) {
    Open().erase(key_);
    std::move(answer_).Run(path, unavailable);
    delete this;
  }

  const std::string key_;
  Answer answer_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

// --- End of downloads -------------------------------------------------------

class CrestUIHandler;
// The window's main WebUI, which takes the window's keys and owns its state,
// and the floating surfaces' page, which only draws what the main one sends.
CrestUIHandler* g_handler = nullptr;
CrestUIHandler* g_float = nullptr;

// Relays the core to the page and the page's messages to the core.
class CrestUIHandler final : public content::WebUIMessageHandler, public CoreHost::Observer {
 public:
  CrestUIHandler() = default;
  CrestUIHandler(const CrestUIHandler&) = delete;
  CrestUIHandler& operator=(const CrestUIHandler&) = delete;
  ~CrestUIHandler() override {
    if (g_handler == this) g_handler = nullptr;
    if (g_float == this) g_float = nullptr;
  }

  // content::WebUIMessageHandler:
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "ready", base::BindRepeating(&CrestUIHandler::HandleReady, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "dispatch", base::BindRepeating(&CrestUIHandler::HandleCall, base::Unretained(this), Call::kDispatch));
    web_ui()->RegisterMessageCallback(
        "query", base::BindRepeating(&CrestUIHandler::HandleCall, base::Unretained(this), Call::kQuery));
    web_ui()->RegisterMessageCallback(
        "pageRequest", base::BindRepeating(&CrestUIHandler::HandleCall, base::Unretained(this), Call::kPageRequest));
    web_ui()->RegisterMessageCallback(
        "showPage", base::BindRepeating(&CrestUIHandler::HandleShowPage, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setPageBounds", base::BindRepeating(&CrestUIHandler::HandleSetPageBounds, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setPageLayout", base::BindRepeating(&CrestUIHandler::HandleSetPageLayout, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "floatReady", base::BindRepeating(&CrestUIHandler::HandleFloatReady, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setFloat", base::BindRepeating(&CrestUIHandler::HandleSetFloat, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "floatEvent", base::BindRepeating(&CrestUIHandler::HandleFloatEvent, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setShortcuts", base::BindRepeating(&CrestUIHandler::HandleSetShortcuts, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setSelectionSearch", base::BindRepeating(&CrestUIHandler::HandleSetSelectionSearch, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "copyLink", base::BindRepeating(&CrestUIHandler::HandleCopyLink, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setOverlay", base::BindRepeating(&CrestUIHandler::HandleSetOverlay, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "showCertificate", base::BindRepeating(&CrestUIHandler::HandleShowCertificate, base::Unretained(this)));
    // Appearance (Linux shell).
    web_ui()->RegisterMessageCallback(
        "setAppearance", base::BindRepeating(&CrestUIHandler::HandleSetAppearance, base::Unretained(this)));
    // Downloads (Linux shell).
    web_ui()->RegisterMessageCallback(
        "openDownload", base::BindRepeating(&CrestUIHandler::HandleOpenDownload, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "showDownloadInFolder", base::BindRepeating(&CrestUIHandler::HandleShowDownloadInFolder, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "chooseDownloadPath", base::BindRepeating(&CrestUIHandler::HandleChooseDownloadPath, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "closeDownloadDialog", base::BindRepeating(&CrestUIHandler::HandleCloseDownloadDialog, base::Unretained(this)));
  }

  void OnJavascriptDisallowed() override { observation_.Reset(); }

  // CoreHost::Observer:
  void OnChanges(base::span<const uint8_t> changes) override {
    if (IsJavascriptAllowed()) FireWebUIListener("crest-changes", Encode(changes));
  }
  void OnPresentation(base::span<const uint8_t> presentation) override {
    if (IsJavascriptAllowed()) FireWebUIListener("crest-presentation", Encode(presentation));
  }

 private:
  enum class Call { kDispatch, kQuery, kPageRequest };

  // The page started: it hears every batch the core published so far, in
  // order, then each new one as it comes.
  void HandleReady(const base::ListValue& args) {
    AllowJavascript();
    // The page that starts the core's line is the window's main WebUI.
    g_handler = this;
    CoreHost* host = CoreHost::Get();
    base::ListValue history;
    if (host) {
      for (const auto& batch : host->history()) history.Append(Encode(batch));
      if (!observation_.IsObserving()) observation_.Observe(host);
    }
    ResolveJavascriptCallback(args[0], base::Value(std::move(history)));
  }

  // args: callback id, base64 message. Answers {status, bytes}.
  void HandleCall(Call call, const base::ListValue& args) {
    AllowJavascript();
    const base::Value& callback = args[0];
    CoreHost* host = CoreHost::Get();
    std::optional<std::vector<uint8_t>> message =
        args.size() > 1 && args[1].is_string() ? base::Base64Decode(args[1].GetString()) : std::nullopt;
    if (!host || !message) {
      RejectJavascriptCallback(callback, base::Value(host ? "The message is not base64." : "Crest's core is not running."));
      return;
    }
    std::vector<uint8_t> out;
    crest_status_t status = CREST_INTERNAL_ERROR;
    switch (call) {
      case Call::kDispatch:
        status = host->Dispatch(*message, out);
        break;
      case Call::kQuery:
        status = host->Query(*message, out);
        break;
      case Call::kPageRequest:
        status = host->PageRequest(*message, out);
        break;
    }
    base::DictValue answer;
    answer.Set("status", status);
    answer.Set("bytes", Encode(out));
    ResolveJavascriptCallback(callback, base::Value(std::move(answer)));
  }

  // args: the core's page id. Shows that page beside the sidebar.
  void HandleShowPage(const base::ListValue& args) {
    if (args.empty() || !args[0].is_string()) return;
    LinuxWindow* window = LinuxWindow::Current();
    if (!window) return;
    // No id: the shown tab has no page (the Start Page), which the WebUI
    // draws in the page's card itself.
    if (args[0].GetString().empty()) {
      window->ShowNoPage();
      return;
    }
    // The sidebar spells ids in lower case; the binding keys pages by
    // GuidText, which spells them in upper case.
    const std::optional<engine::Guid> page = ParseGuid(args[0].GetString());
    if (!page) return;
    window->ShowPage(GuidText(*page));
  }

  // args: x, y, width, height of the page's place in the WebUI, in CSS
  // pixels, which are the window contents' at the WebUI's natural zoom.
  void HandleSetPageBounds(const base::ListValue& args) {
    if (args.size() != 4) return;
    int values[4];
    for (size_t index = 0; index < 4; ++index) {
      if (!args[index].is_int() && !args[index].is_double()) return;
      values[index] = static_cast<int>(args[index].GetDouble());
    }
    if (values[2] < 0 || values[3] < 0) return;
    if (LinuxWindow* window = LinuxWindow::Current()) {
      window->SetPageBounds(gfx::Rect(values[0], values[1], values[2], values[3]));
    }
  }

  // args: one list per page, [core page id, x, y, width, height, whether it
  // stays over the raised WebUI, corner radius], the later over the earlier,
  // then the id of the page in use (empty when none is). Shows those pages
  // and no other: the cards of a split, and a Peek's page over them.
  void HandleSetPageLayout(const base::ListValue& args) {
    if (args.size() != 2 || !args[0].is_list() || !args[1].is_string()) return;
    LinuxWindow* window = LinuxWindow::Current();
    if (!window) return;
    std::vector<LinuxWindow::PageSlot> slots;
    for (const base::Value& entry : args[0].GetList()) {
      const base::ListValue* fields = entry.GetIfList();
      if (!fields || fields->size() != 7 || !(*fields)[0].is_string()) return;
      const std::optional<engine::Guid> page = ParseGuid((*fields)[0].GetString());
      if (!page) return;
      int values[4];
      for (size_t index = 0; index < 4; ++index) {
        const base::Value& value = (*fields)[index + 1];
        if (!value.is_int() && !value.is_double()) return;
        values[index] = static_cast<int>(value.GetDouble());
      }
      if (values[2] < 0 || values[3] < 0) return;
      const base::Value& radius = (*fields)[6];
      slots.push_back(LinuxWindow::PageSlot{
          .page = GuidText(*page),
          .bounds = gfx::Rect(values[0], values[1], values[2], values[3]),
          .above = (*fields)[5].GetIfBool().value_or(false),
          .corner_radius = radius.is_int() || radius.is_double() ? static_cast<float>(radius.GetDouble()) : 0});
    }
    std::string focused;
    if (!args[1].GetString().empty()) {
      const std::optional<engine::Guid> page = ParseGuid(args[1].GetString());
      if (!page) return;
      focused = GuidText(*page);
    }
    window->SetPageLayout(slots, focused);
  }

  // The floating surfaces' page started; it hears what the main WebUI sends.
  void HandleFloatReady(const base::ListValue& args) {
    AllowJavascript();
    g_float = this;
    if (g_handler) g_handler->Fire("crest-float-ready", base::Value());
  }

  // From the main WebUI. args: x, y, width, height (empty hides), whether the
  // surface takes the keyboard, and the state it draws, as JSON text.
  void HandleSetFloat(const base::ListValue& args) {
    if (args.size() != 6 || !args[5].is_string()) return;
    int values[4];
    for (size_t index = 0; index < 4; ++index) {
      if (!args[index].is_int() && !args[index].is_double()) return;
      values[index] = static_cast<int>(args[index].GetDouble());
    }
    if (values[2] < 0 || values[3] < 0) return;
    if (g_float) g_float->Fire("crest-float-state", base::Value(args[5].GetString()));
    if (LinuxWindow* window = LinuxWindow::Current()) {
      window->SetFloat(gfx::Rect(values[0], values[1], values[2], values[3]), args[4].GetIfBool().value_or(false));
    }
  }

  // From the floating surfaces' page: what the person did there, as JSON
  // text, for the main WebUI to act on.
  void HandleFloatEvent(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_string()) return;
    if (g_handler) g_handler->Fire("crest-float-event", base::Value(args[0].GetString()));
  }

 public:
  void Fire(const std::string& event, const base::Value& value) {
    if (IsJavascriptAllowed()) FireWebUIListener(event, value);
  }

 private:
  // args: one list per key, [key, ctrl, alt, meta, shift (-1 when it does
  // not matter), reserved].
  void HandleSetShortcuts(const base::ListValue& args) {
    std::vector<Shortcut> shortcuts;
    for (const base::Value& entry : args) {
      const base::ListValue* fields = entry.GetIfList();
      if (!fields || fields->size() != 6 || !(*fields)[0].is_string()) return;
      Shortcut shortcut;
      shortcut.key = (*fields)[0].GetString();
      shortcut.ctrl = (*fields)[1].GetIfBool().value_or(false);
      shortcut.alt = (*fields)[2].GetIfBool().value_or(false);
      shortcut.meta = (*fields)[3].GetIfBool().value_or(false);
      const int shift = (*fields)[4].GetIfInt().value_or(-1);
      if (shift >= 0) shortcut.shift = shift == 1;
      shortcut.reserved = (*fields)[5].GetIfBool().value_or(false);
      shortcuts.push_back(std::move(shortcut));
    }
    Shortcuts() = std::move(shortcuts);
  }

  // args: the page the window shows (empty for none) and the name of the
  // engine a selection on it searches with.
  void HandleSetSelectionSearch(const base::ListValue& args) {
    if (args.size() != 2 || !args[0].is_string() || !args[1].is_string()) return;
    const std::optional<engine::Guid> page = ParseGuid(args[0].GetString());
    ShownSelectionSearch() = SelectionSearch{.page = page ? GuidText(*page) : std::string(),
                                             .engine = base::UTF8ToUTF16(args[1].GetString())};
  }

  // args: the core's clean copy of an address the page's menu copies.
  void HandleCopyLink(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_string()) return;
    const GURL url(args[0].GetString());
    if (!url.is_valid()) return;
    // The writer puts the text on the clipboard as it goes.
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(base::UTF8ToUTF16(url.spec()));
  }

 public:
  // Hands the WebUI a key it claimed, to perform.
  bool FireShortcut(base::DictValue key) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener("crest-shortcut", key);
    return true;
  }

  bool FireCommand(const std::string& command) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener("crest-command", base::Value(command));
    return true;
  }

  bool FireSearchSelection(base::DictValue search) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener("crest-search-selection", search);
    return true;
  }

  bool FireCopyLink(const GURL& url) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener("crest-copy-link", base::Value(url.spec()));
    return true;
  }

 private:
  // args: whether the WebUI draws a floating surface over the page now.
  void HandleSetOverlay(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_bool()) return;
    if (LinuxWindow* window = LinuxWindow::Current()) window->SetOverlay(args[0].GetBool());
  }

  // args: the core's page id. Site Controls' Review Certificate: shows the
  // certificate the engine verified for the page's visible entry in
  // Chromium's certificate viewer, a dialog over the page, as the Mac's opens
  // the system's certificate panel as a sheet on its window.
  void HandleShowCertificate(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_string()) return;
    const std::optional<engine::Guid> id = ParseGuid(args[0].GetString());
    EnginePage* page = id ? EngineBinding::Get().Find(GuidText(*id)) : nullptr;
    content::WebContents* contents = page ? page->web_contents() : nullptr;
    content::NavigationEntry* entry = contents ? contents->GetController().GetVisibleEntry() : nullptr;
    if (!entry || !entry->GetSSL().certificate) return;
    ShowCertificateViewer(contents, contents->GetTopLevelNativeWindow(), entry->GetSSL().certificate.get());
  }

  // --- Appearance (Linux shell) ---------------------------------------------

  // args: the person's appearance choice, "system", "light" or "dark". Every
  // instance of the native theme hears the change and redraws with it.
  void HandleSetAppearance(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_string()) return;
    const auto scheme = ColorSchemeNamed(args[0].GetString());
    if (!scheme) return;
    ui::NativeTheme::SetPreferredColorSchemeOverride(*scheme);
  }

  // --- Downloads (Linux shell) ----------------------------------------------

  // args: a finished download's destination, as a file: URL. Opens the file
  // in the desktop's app for it.
  void HandleOpenDownload(const base::ListValue& args) {
    const base::FilePath path = DownloadFile(args);
    if (path.empty()) return;
    platform_util::OpenItem(Profile::FromWebUI(web_ui()), path, platform_util::OPEN_FILE, base::DoNothing());
  }

  // args: a finished download's destination, as a file: URL. Shows it in the
  // desktop's file manager.
  void HandleShowDownloadInFolder(const base::ListValue& args) {
    const base::FilePath path = DownloadFile(args);
    if (path.empty()) return;
    platform_util::ShowItemInFolder(Profile::FromWebUI(web_ui()), path);
  }

  // args: callback id, the name to save under (the WebUI made it safe),
  // whether to ask where to save, and the question's key. Answers {path, null when the person
  // cancels or the folder is unavailable, and unavailable}.
  void HandleChooseDownloadPath(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 4 || !args[1].is_string() || !args[2].is_bool() || !args[3].is_string()) {
      RejectJavascriptCallback(args[0], base::Value("chooseDownloadPath takes a name, whether to ask and a key."));
      return;
    }
    const base::FilePath name = base::FilePath::FromUTF8Unsafe(args[1].GetString()).BaseName();
    VLOG(1) << "The window finds where " << name << " goes" << (args[2].GetBool() ? ", in a save dialog" : "");
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING}, base::BindOnce(&FreeDownloadPath, name),
        base::BindOnce(&CrestUIHandler::ChooseDownloadPath, weak_factory_.GetWeakPtr(), args[0].Clone(), name,
                       args[2].GetBool(), args[3].GetString()));
  }

  // args: callback id, the key of a question the core settled. Closes its
  // save dialog if one is open.
  void HandleCloseDownloadDialog(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 2 || !args[1].is_string()) {
      RejectJavascriptCallback(args[0], base::Value("closeDownloadDialog takes a key."));
      return;
    }
    DownloadSaveDialog::Close(args[1].GetString());
    ResolveJavascriptCallback(args[0], base::Value());
  }

  void ChooseDownloadPath(base::Value callback,
                          const base::FilePath& name,
                          bool asks,
                          const std::string& key,
                          const base::FilePath& free) {
    if (!asks) {
      AnswerDownloadPath(std::move(callback), free, free.empty());
      return;
    }
    DownloadSaveDialog::Show(
        web_ui()->GetWebContents(), key, free.empty() ? name : free,
        base::BindOnce(&CrestUIHandler::AnswerDownloadPath, weak_factory_.GetWeakPtr(), std::move(callback)));
  }

  void AnswerDownloadPath(base::Value callback, base::FilePath path, bool unavailable) {
    if (!IsJavascriptAllowed()) return;
    base::DictValue answer;
    answer.Set("path", path.empty() ? base::Value() : base::Value(path.AsUTF8Unsafe()));
    answer.Set("unavailable", unavailable);
    ResolveJavascriptCallback(callback, base::Value(std::move(answer)));
  }

  // --- End of downloads -----------------------------------------------------

  base::ScopedObservation<CoreHost, CoreHost::Observer> observation_{this};
  base::WeakPtrFactory<CrestUIHandler> weak_factory_{this};
};

}  // namespace

bool ClaimShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined) {
  if (!g_handler || event.GetType() != input::NativeWebKeyboardEvent::Type::kRawKeyDown) return false;
  const int modifiers = event.GetModifiers();
  const bool ctrl = modifiers & blink::WebInputEvent::kControlKey;
  const bool alt = modifiers & blink::WebInputEvent::kAltKey;
  const bool meta = modifiers & blink::WebInputEvent::kMetaKey;
  const bool shift = modifiers & blink::WebInputEvent::kShiftKey;
  const std::string key = KeyName(event.windows_key_code);
  if (key.empty()) return false;
  // A key without Ctrl, Alt or Meta stays the page's, but for Escape, which
  // closes a Peek before its page sees it, as the Mac's Peek keyboard
  // monitor takes it.
  if (!ctrl && !alt && !meta && key != "Escape") return false;
  for (const Shortcut& shortcut : Shortcuts()) {
    if (!page_declined && !shortcut.reserved) continue;
    if (shortcut.key != key && !(shortcut.key == "+" && key == "=")) continue;
    if (shortcut.ctrl != ctrl || shortcut.alt != alt || shortcut.meta != meta) continue;
    if (shortcut.shift && *shortcut.shift != shift) continue;
    base::DictValue fired;
    fired.Set("key", key);
    fired.Set("ctrlKey", ctrl);
    fired.Set("altKey", alt);
    fired.Set("metaKey", meta);
    fired.Set("shiftKey", shift);
    return g_handler->FireShortcut(std::move(fired));
  }
  return false;
}

void PerformCommand(const std::string& command) {
  if (g_handler) g_handler->FireCommand(command);
}

std::u16string SelectionSearchEngine(const std::string& page) {
  const SelectionSearch& search = ShownSelectionSearch();
  return !page.empty() && search.page == page ? search.engine : std::u16string();
}

bool SearchSelection(const std::string& page, const std::u16string& text) {
  if (!g_handler) return false;
  base::DictValue search;
  // The sidebar spells ids in lower case.
  search.Set("pageId", base::ToLowerASCII(page));
  search.Set("text", text);
  return g_handler->FireSearchSelection(std::move(search));
}

bool CopyLink(const GURL& url) {
  return g_handler && url.is_valid() && g_handler->FireCopyLink(url);
}

void ReportPageFocused(const std::string& page) {
  if (g_handler) g_handler->Fire("crest-page-focused", base::Value(page));
}

CrestUIConfig::CrestUIConfig() : DefaultWebUIConfig(content::kChromeUIScheme, kCrestUIHost) {}

CrestUI::CrestUI(content::WebUI* web_ui) : content::WebUIController(web_ui) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kCrestUIHost);
  const base::FilePath directory = UIDirectory();
  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating(
          [](const base::FilePath& directory, const std::string& path,
             content::WebUIDataSource::GotDataCallback callback) {
            base::ThreadPool::PostTaskAndReplyWithResult(
                FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
                base::BindOnce(&ReadUIFile, directory, path), std::move(callback));
          },
          directory));
  source->DisableTrustedTypesCSP();
  source->OverrideContentSecurityPolicy(network::mojom::CSPDirectiveName::ImgSrc,
                                        "img-src chrome://resources chrome://favicon2 'self' data: https:;");
  web_ui->AddMessageHandler(std::make_unique<CrestUIHandler>());
}

CrestUI::~CrestUI() = default;

void RegisterCrestUI() {
  static bool registered = false;
  if (registered) return;
  registered = true;
  content::WebUIConfigMap::GetInstance().AddWebUIConfig(std::make_unique<CrestUIConfig>());
}

}  // namespace crest
