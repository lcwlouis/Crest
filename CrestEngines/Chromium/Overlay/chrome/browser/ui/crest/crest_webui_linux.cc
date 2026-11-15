#include "chrome/browser/ui/crest/crest_webui_linux.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/base64.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/scoped_observation.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "components/input/native_web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "chrome/browser/ui/crest/crest_core_host_linux.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
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
  switch (code) {
    case ui::VKEY_LEFT: return "ArrowLeft";
    case ui::VKEY_RIGHT: return "ArrowRight";
    case ui::VKEY_UP: return "ArrowUp";
    case ui::VKEY_DOWN: return "ArrowDown";
    case ui::VKEY_TAB: return "Tab";
    case ui::VKEY_RETURN: return "Enter";
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

class CrestUIHandler;
CrestUIHandler* g_handler = nullptr;

// Relays the core to the page and the page's messages to the core.
class CrestUIHandler final : public content::WebUIMessageHandler, public CoreHost::Observer {
 public:
  // The window has one chrome://crest, which takes the window's keys.
  CrestUIHandler() { g_handler = this; }
  CrestUIHandler(const CrestUIHandler&) = delete;
  CrestUIHandler& operator=(const CrestUIHandler&) = delete;
  ~CrestUIHandler() override {
    if (g_handler == this) g_handler = nullptr;
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
        "setShortcuts", base::BindRepeating(&CrestUIHandler::HandleSetShortcuts, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setSelectionSearch", base::BindRepeating(&CrestUIHandler::HandleSetSelectionSearch, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "copyLink", base::BindRepeating(&CrestUIHandler::HandleCopyLink, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "setOverlay", base::BindRepeating(&CrestUIHandler::HandleSetOverlay, base::Unretained(this)));
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

  base::ScopedObservation<CoreHost, CoreHost::Observer> observation_{this};
};

}  // namespace

bool ClaimShortcut(const input::NativeWebKeyboardEvent& event, bool page_declined) {
  if (!g_handler || event.GetType() != input::NativeWebKeyboardEvent::Type::kRawKeyDown) return false;
  const int modifiers = event.GetModifiers();
  const bool ctrl = modifiers & blink::WebInputEvent::kControlKey;
  const bool alt = modifiers & blink::WebInputEvent::kAltKey;
  const bool meta = modifiers & blink::WebInputEvent::kMetaKey;
  const bool shift = modifiers & blink::WebInputEvent::kShiftKey;
  if (!ctrl && !alt && !meta) return false;
  const std::string key = KeyName(event.windows_key_code);
  if (key.empty()) return false;
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
