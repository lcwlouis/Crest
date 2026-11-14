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
#include "base/task/thread_pool.h"
#include "base/values.h"
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

// Relays the core to the page and the page's messages to the core.
class CrestUIHandler final : public content::WebUIMessageHandler, public CoreHost::Observer {
 public:
  CrestUIHandler() = default;
  CrestUIHandler(const CrestUIHandler&) = delete;
  CrestUIHandler& operator=(const CrestUIHandler&) = delete;
  ~CrestUIHandler() override = default;

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
    // The sidebar spells ids in lower case; the binding keys pages by
    // GuidText, which spells them in upper case.
    const std::optional<engine::Guid> page = ParseGuid(args[0].GetString());
    if (!page) return;
    if (LinuxWindow* window = LinuxWindow::Current()) window->ShowPage(GuidText(*page));
  }

  base::ScopedObservation<CoreHost, CoreHost::Observer> observation_{this};
};

}  // namespace

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
