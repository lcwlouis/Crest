#include "chrome/browser/ui/crest/crest_system_webui_linux.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "base/base64.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_page.h"
#include "chrome/browser/ui/crest/crest_linux_window.h"
#include "chrome/browser/ui/crest/crest_notifications_linux.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "printing/buildflags/buildflags.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/selected_file_info.h"

#if BUILDFLAG(ENABLE_PRINTING)
#include "chrome/browser/printing/print_view_manager_common.h"
#include "mojo/public/cpp/bindings/pending_associated_remote.h"
#endif

namespace crest {

namespace {

// The core's page id the WebUI sent, in GuidText's spelling, which the
// binding and the windows key pages by; empty when it is not one.
std::string PageKey(const base::Value& value) {
  const std::optional<engine::Guid> id = value.is_string() ? ParseGuid(value.GetString()) : std::nullopt;
  return id ? GuidText(*id) : std::string();
}

// The page the core's id `value` names, or nullptr.
content::WebContents* PageContents(const base::Value& value) {
  const std::string page = PageKey(value);
  EnginePage* engine_page = page.empty() ? nullptr : EngineBinding::Get().Find(page);
  return engine_page ? engine_page->web_contents() : nullptr;
}

// The save dialog for a page's export, which deletes itself once answered,
// as crest_webui_linux.cc's DownloadSaveDialog does for a download. Answers
// the path, or none when the person cancels; `unavailable` when no dialog
// can be shown.
class ExportSaveDialog final : public ui::SelectFileDialog::Listener {
 public:
  using Answer = base::OnceCallback<void(base::FilePath path, bool unavailable)>;

  static void Show(content::WebContents* contents,
                   const std::u16string& title,
                   const base::FilePath& suggested,
                   const base::FilePath::StringType& extension,
                   Answer answer) {
    auto* listener = new ExportSaveDialog(std::move(answer));
    listener->dialog_ = ui::SelectFileDialog::Create(listener, nullptr);
    if (!listener->dialog_) {
      listener->Finish(base::FilePath(), true);
      return;
    }
    ui::SelectFileDialog::FileTypeInfo types;
    types.extensions = {{extension}};
    types.include_all_files = true;
    listener->dialog_->SelectFile(ui::SelectFileDialog::SELECT_SAVEAS_FILE, title, suggested, &types, 1, extension,
                                  contents->GetTopLevelNativeWindow());
  }

  // ui::SelectFileDialog::Listener:
  void FileSelected(const ui::SelectedFileInfo& file, int index) override { Finish(file.path(), false); }
  void FileSelectionCanceled() override { Finish(base::FilePath(), false); }

 private:
  explicit ExportSaveDialog(Answer answer) : answer_(std::move(answer)) {}
  ~ExportSaveDialog() override {
    if (dialog_) dialog_->ListenerDestroyed();
  }

  void Finish(const base::FilePath& path, bool unavailable) {
    std::move(answer_).Run(path, unavailable);
    delete this;
  }

  Answer answer_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

// Writes `contents` to `path`, replacing what is there. Off the UI thread.
bool WriteExport(const base::FilePath& path, const std::vector<uint8_t>& contents) {
  return base::WriteFile(path, contents);
}

class SystemUIHandler;

// Every page of chrome://crest open now.
std::vector<SystemUIHandler*>& SystemHandlers() {
  static base::NoDestructor<std::vector<SystemUIHandler*>> handlers;
  return *handlers;
}

class SystemUIHandler final : public content::WebUIMessageHandler {
 public:
  SystemUIHandler() { SystemHandlers().push_back(this); }
  SystemUIHandler(const SystemUIHandler&) = delete;
  SystemUIHandler& operator=(const SystemUIHandler&) = delete;
  ~SystemUIHandler() override { std::erase(SystemHandlers(), this); }

  // content::WebUIMessageHandler:
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "systemReady", base::BindRepeating(&SystemUIHandler::HandleSystemReady, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "relayoutInspector", base::BindRepeating(&SystemUIHandler::HandleRelayoutInspector, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "isFrontWindow", base::BindRepeating(&SystemUIHandler::HandleIsFrontWindow, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "showNotification", base::BindRepeating(&SystemUIHandler::HandleShowNotification, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "closeNotification", base::BindRepeating(&SystemUIHandler::HandleCloseNotification, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "printPage", base::BindRepeating(&SystemUIHandler::HandlePrintPage, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "saveExport", base::BindRepeating(&SystemUIHandler::HandleSaveExport, base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "copyImage", base::BindRepeating(&SystemUIHandler::HandleCopyImage, base::Unretained(this)));
  }

  // Fires `event` to the page; false while it cannot hear it.
  bool Fire(const std::string& event, const base::Value& value) {
    if (!IsJavascriptAllowed()) return false;
    FireWebUIListener(event, value);
    return true;
  }

  content::WebContents* contents() { return web_ui()->GetWebContents(); }

  // The person clicked the notification `key` that `origin`'s page showed. A
  // window that closed since hands it to the browser window used last, whose
  // page heard the same notification posted.
  static void DeliverClick(base::WeakPtr<SystemUIHandler> origin, const std::string& key) {
    const base::Value clicked(key);
    if (origin && origin->Fire("crest-notification-clicked", clicked)) return;
    const std::vector<std::string> stacked = LinuxWindow::Stacked();
    LinuxWindow* front = stacked.empty() ? nullptr : LinuxWindow::Find(stacked.front());
    for (SystemUIHandler* handler : SystemHandlers()) {
      if (front && handler->contents() == front->ui_contents()) handler->Fire("crest-notification-clicked", clicked);
    }
  }

 private:
  LinuxWindow* Window() { return LinuxWindow::Drawing(web_ui()->GetWebContents()); }

  // The page listens for what the desktop tells it.
  void HandleSystemReady(const base::ListValue& args) { AllowJavascript(); }

  // Whether this page draws the browser window used last. Every window's
  // page hears each presentation the engine makes; that one alone answers
  // what must be answered once, such as a notification to show or a media
  // session to follow.
  bool IsFrontWindow() {
    LinuxWindow* window = Window();
    if (!window || window->ui_contents() != web_ui()->GetWebContents()) return false;
    const std::vector<std::string> stacked = LinuxWindow::Stacked();
    return !stacked.empty() && stacked.front() == window->id();
  }

  // args: callback id. Answers whether this page draws the browser window
  // used last.
  void HandleIsFrontWindow(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 1) return;
    ResolveJavascriptCallback(args[0], base::Value(IsFrontWindow()));
  }

  // args: callback id, a key the page names the notification by, its title,
  // the site that posted it, its body, whether it is silent. Answers
  // "shown", "declined" when the desktop did not take it, or "elsewhere"
  // when another window shows the notifications. A click fires
  // crest-notification-clicked with the key to this page.
  void HandleShowNotification(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 6 || !args[1].is_string() || !args[2].is_string() || !args[3].is_string() ||
        !args[4].is_string() || !args[5].is_bool()) {
      RejectJavascriptCallback(args[0], base::Value("showNotification takes a key, a title, a site, a body and silence."));
      return;
    }
    if (!IsFrontWindow()) {
      ResolveJavascriptCallback(args[0], base::Value("elsewhere"));
      return;
    }
    const std::string key = args[1].GetString();
    DesktopNotifications::Get().Show(
        key,
        DesktopNotifications::Delivery{.title = args[2].GetString(),
                                       .site = args[3].GetString(),
                                       .body = args[4].GetString(),
                                       .silent = args[5].GetBool()},
        base::BindOnce(&SystemUIHandler::AnswerShown, weak_factory_.GetWeakPtr(), args[0].Clone()),
        base::BindOnce(&DeliverClick, weak_factory_.GetWeakPtr(), key));
  }

  void AnswerShown(base::Value callback, bool shown) {
    if (IsJavascriptAllowed()) ResolveJavascriptCallback(callback, base::Value(shown ? "shown" : "declined"));
  }

  // args: the key of a notification the page showed, which goes.
  void HandleCloseNotification(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_string() || !IsFrontWindow()) return;
    DesktopNotifications::Get().Close(args[0].GetString());
  }

  // args: the core's id of a page whose docked inspector moved its split, as
  // InspectorLayoutChanged says. The window showing it places the page again.
  void HandleRelayoutInspector(const base::ListValue& args) {
    const std::string page = args.size() == 1 ? PageKey(args[0]) : std::string();
    LinuxWindow* window = Window();
    if (!page.empty() && window) window->RelayoutInspector(page);
  }

  // --- Page output ----------------------------------------------------------
  // Printing, saving what a page exported and copying a capture of it, which
  // the Mac does with NSPrintOperation, NSSavePanel and NSPasteboard.

  // args: the core's id of a page. Opens Chromium's print preview over it,
  // which the page's Browser hosts in the window as a tab-modal dialog.
  void HandlePrintPage(const base::ListValue& args) {
    content::WebContents* page = args.size() == 1 ? PageContents(args[0]) : nullptr;
    if (!page) return;
#if BUILDFLAG(ENABLE_PRINTING)
    printing::StartPrint(page, mojo::NullAssociatedRemote(), /*print_preview_disabled=*/false,
                         /*has_selection=*/false);
#endif
  }

  // args: callback id, the save dialog's title, the name it proposes (the
  // WebUI made it safe), its extension without the dot, the file's contents
  // as base64. Asks where to save and writes the file there. Answers
  // "saved", "cancelled", "failed" when it could not be written, or
  // "unavailable" when no dialog can be shown.
  void HandleSaveExport(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 5 || !args[1].is_string() || !args[2].is_string() || !args[3].is_string() ||
        !args[4].is_string()) {
      RejectJavascriptCallback(args[0], base::Value("saveExport takes a title, a name, an extension and contents."));
      return;
    }
    std::optional<std::vector<uint8_t>> contents = base::Base64Decode(args[4].GetString());
    if (!contents) {
      ResolveJavascriptCallback(args[0], base::Value("failed"));
      return;
    }
    base::FilePath folder;
    base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &folder);
    const base::FilePath name = base::FilePath::FromUTF8Unsafe(args[2].GetString()).BaseName();
    ExportSaveDialog::Show(
        web_ui()->GetWebContents(), base::UTF8ToUTF16(args[1].GetString()), folder.empty() ? name : folder.Append(name),
        base::FilePath::FromUTF8Unsafe(args[3].GetString()).value(),
        base::BindOnce(&SystemUIHandler::WriteChosenExport, weak_factory_.GetWeakPtr(), args[0].Clone(),
                       std::move(*contents)));
  }

  void WriteChosenExport(base::Value callback, std::vector<uint8_t> contents, base::FilePath path, bool unavailable) {
    if (path.empty()) {
      if (IsJavascriptAllowed()) ResolveJavascriptCallback(callback, base::Value(unavailable ? "unavailable" : "cancelled"));
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
        base::BindOnce(&WriteExport, path, std::move(contents)),
        base::BindOnce(&SystemUIHandler::AnswerWritten, weak_factory_.GetWeakPtr(), std::move(callback)));
  }

  void AnswerWritten(base::Value callback, bool written) {
    if (IsJavascriptAllowed()) ResolveJavascriptCallback(callback, base::Value(written ? "saved" : "failed"));
  }

  // args: callback id, a PNG as base64. Puts the image on the clipboard.
  // Answers whether it could.
  void HandleCopyImage(const base::ListValue& args) {
    AllowJavascript();
    if (args.size() != 2 || !args[1].is_string()) {
      RejectJavascriptCallback(args[0], base::Value("copyImage takes a PNG."));
      return;
    }
    std::optional<std::vector<uint8_t>> png = base::Base64Decode(args[1].GetString());
    SkBitmap bitmap = png ? gfx::PNGCodec::Decode(*png) : SkBitmap();
    if (bitmap.isNull()) {
      ResolveJavascriptCallback(args[0], base::Value(false));
      return;
    }
    ui::ScopedClipboardWriter(ui::ClipboardBuffer::kCopyPaste).WriteImage(bitmap);
    ResolveJavascriptCallback(args[0], base::Value(true));
  }

  base::WeakPtrFactory<SystemUIHandler> weak_factory_{this};
};

}  // namespace

std::unique_ptr<content::WebUIMessageHandler> CreateSystemUIHandler() {
  return std::make_unique<SystemUIHandler>();
}

}  // namespace crest
