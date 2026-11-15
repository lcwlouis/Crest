#include "chrome/browser/ui/crest/crest_core_host_linux.h"

#include <dlfcn.h>

#include <atomic>
#include <utility>

#include "base/check.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "chrome/browser/ui/crest/crest_contracts.h"
#include "chrome/browser/ui/crest/crest_engine.h"
#include "chrome/browser/ui/crest/crest_engine_binding.h"
#include "chrome/browser/ui/crest/crest_engine_contract.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"

namespace crest {

namespace {

// Where the core's library is: the switch's path, or beside the browser.
constexpr char kCoreLibrarySwitch[] = "crest-core-library";
constexpr char kCoreLibraryName[] = "CrestCore.Native.so";

// The device class whose defaults the core applies (DevicePlatform.Desktop).
constexpr uint64_t kDesktop = 0;

CoreHost* g_host = nullptr;

// The core's wake runs on whichever core thread published, so the host keeps
// at most one drain queued on the UI thread.
std::atomic<bool> g_drain_queued{false};

base::FilePath CoreLibraryPath() {
  const auto* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(kCoreLibrarySwitch)) {
    return command_line->GetSwitchValuePath(kCoreLibrarySwitch);
  }
  base::FilePath directory;
  base::PathService::Get(base::DIR_EXE, &directory);
  return directory.Append(kCoreLibraryName);
}

// One encoded AppConfiguration: StorageDirectory, Platform, and no import
// names, languages or filter resource override.
std::vector<uint8_t> AppConfiguration(const base::FilePath& storage) {
  engine::WireWriter writer;
  const std::string& directory = storage.value();
  writer.WriteVarint(1);  // StorageDirectory is present.
  writer.WriteVarint(directory.size());
  writer.WriteRaw(reinterpret_cast<const uint8_t*>(directory.data()), directory.size());
  writer.WriteVarint(kDesktop);
  writer.WriteVarint(0);  // ImportNames
  writer.WriteVarint(0);  // Languages
  writer.WriteVarint(0);  // FilterResourcesUrl
  return writer.Take();
}

// What the Linux binding vouches for so far. The rest of the Mac binding's
// capabilities follow as the Linux shell gains the UI each one needs.
std::vector<uint8_t> EngineRegistration() {
  using engine::EngineCapability;
  return engine::Encode(engine::EngineRegistration{
      .kind = engine::EngineKind::kChromium,
      .capabilities = {EngineCapability::kPages, EngineCapability::kNavigation, EngineCapability::kFind,
                       EngineCapability::kZoom, EngineCapability::kInteractionState,
                       EngineCapability::kPageResidency, EngineCapability::kPopups,
                       EngineCapability::kWorkspaceProfiles, EngineCapability::kWorkspaceTransfer,
                       EngineCapability::kProfileDeletion, EngineCapability::kBeforeUnload,
                       EngineCapability::kInternalPages},
      .is_default = true});
}

std::vector<uint8_t> Bytes(const crest_buffer_t& buffer) {
  return buffer.bytes ? std::vector<uint8_t>(buffer.bytes, buffer.bytes + buffer.length)
                      : std::vector<uint8_t>();
}

}  // namespace

// The core's C ABI, looked up in the library the host loaded. The library is
// loaded RTLD_GLOBAL so the request filter finds the content filter's exports
// the same way it does on the Mac, and it is never unloaded.
struct CoreHost::Library {
  void* handle = nullptr;
  decltype(&crest_core_abi_version) abi_version = nullptr;
  decltype(&crest_app_create) create = nullptr;
  decltype(&crest_app_destroy) destroy = nullptr;
  decltype(&crest_app_dispatch) dispatch = nullptr;
  decltype(&crest_app_query) query = nullptr;
  decltype(&crest_app_set_wake) set_wake = nullptr;
  decltype(&crest_app_drain) drain = nullptr;
  decltype(&crest_app_end_turn) end_turn = nullptr;
  decltype(&crest_buffer_free) buffer_free = nullptr;
  decltype(&crest_engine_register) engine_register = nullptr;
  decltype(&crest_engine_unregister) engine_unregister = nullptr;

  bool Load(const base::FilePath& path, std::string* error) {
    handle = dlopen(path.value().c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (!handle) {
      *error = std::string("Cannot load Crest's core: ") + dlerror();
      return false;
    }
    bool missing = false;
    auto find = [&](auto& function, const char* name) {
      function = reinterpret_cast<std::remove_reference_t<decltype(function)>>(dlsym(handle, name));
      if (!function) {
        *error = std::string("Crest's core lacks ") + name;
        missing = true;
      }
    };
    find(abi_version, "crest_core_abi_version");
    find(create, "crest_app_create");
    find(destroy, "crest_app_destroy");
    find(dispatch, "crest_app_dispatch");
    find(query, "crest_app_query");
    find(set_wake, "crest_app_set_wake");
    find(drain, "crest_app_drain");
    find(end_turn, "crest_app_end_turn");
    find(buffer_free, "crest_buffer_free");
    find(engine_register, "crest_engine_register");
    find(engine_unregister, "crest_engine_unregister");
    if (missing) return false;
    if (abi_version() != CREST_ABI_VERSION) {
      *error = "Crest's core speaks another ABI version. Rebuild the core with this browser.";
      return false;
    }
    return true;
  }

  // Copies and frees a buffer the core returned.
  std::vector<uint8_t> Take(crest_buffer_t& buffer) {
    std::vector<uint8_t> bytes = Bytes(buffer);
    buffer_free(&buffer);
    return bytes;
  }
};

// static
CoreHost* CoreHost::Get() {
  return g_host;
}

// static
bool CoreHost::Start(const base::FilePath& storage, std::string* error) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  CHECK(!g_host);
  auto library = std::make_unique<Library>();
  if (!library->Load(CoreLibraryPath(), error)) return false;
  if (!base::CreateDirectory(storage)) {
    *error = "Cannot create Crest's storage directory " + storage.value();
    return false;
  }

  static constexpr uint8_t kFingerprint[] = CREST_CONTRACTS_FINGERPRINT;
  const std::vector<uint8_t> configuration = AppConfiguration(storage);
  uint64_t app = 0;
  crest_buffer_t rejection = {nullptr, 0};
  const crest_status_t created = library->create(kFingerprint, sizeof(kFingerprint), configuration.data(),
                                                 configuration.size(), &app, &rejection);
  library->Take(rejection);
  if (created != CREST_OK) {
    *error = created == CREST_REJECTED ? "Crest's core cannot use its session file in " + storage.value()
                                       : "Crest's core refused to start (status " + std::to_string(created) + ")";
    return false;
  }

  g_host = new CoreHost(std::move(library), app);

  // The binding registers before anything drains, so the first commands the
  // core issues already have an engine to run on.
  auto& binding = EngineBinding::Get();
  const crest_engine_binding_t table = binding.Table();
  const auto& engine_fingerprint = EngineBinding::Fingerprint();
  const std::vector<uint8_t> registration = EngineRegistration();
  crest_buffer_t refusal = {nullptr, 0};
  const crest_status_t registered = g_host->library_->engine_register(
      app, engine_fingerprint.data(), engine_fingerprint.size(), registration.data(), registration.size(), &table,
      &g_host->engine_, &refusal);
  g_host->library_->Take(refusal);
  CHECK_EQ(registered, CREST_OK) << "Crest's core refused the Chromium engine binding";

  const crest_engine_pages_t pages = binding.Pages();
  pages.present_to(pages.context, &CoreHost::Present, g_host);
  // A wake set while changes wait is called at once.
  g_host->library_->set_wake(app, &CoreHost::Wake, g_host);
  return true;
}

CoreHost::CoreHost(std::unique_ptr<Library> library, uint64_t app) : library_(std::move(library)), app_(app) {}

CoreHost::~CoreHost() = default;

crest_status_t CoreHost::Dispatch(base::span<const uint8_t> intent, std::vector<uint8_t>& out) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (shut_down_) return CREST_INVALID_STATE;
  crest_buffer_t buffer = {nullptr, 0};
  const crest_status_t status = library_->dispatch(app_, intent.data(), intent.size(), &buffer);
  out = library_->Take(buffer);
  if (status == CREST_OK) Publish(out);
  return status;
}

crest_status_t CoreHost::Query(base::span<const uint8_t> query, std::vector<uint8_t>& out) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (shut_down_) return CREST_INVALID_STATE;
  crest_buffer_t buffer = {nullptr, 0};
  const crest_status_t status = library_->query(app_, query.data(), query.size(), &buffer);
  out = library_->Take(buffer);
  return status;
}

// The generator writes C++ only for the engine contract, so this one query
// the shell asks without a WebUI is written here: EngineWindowPlacement's
// fields in their declared order after its tag, and EngineWindowPlace's in
// the answer. A change to either record changes the fingerprint, which
// CoreHost::Start checks, and must change these lines with it.
std::optional<CoreHost::EngineWindowPlace> CoreHost::PlaceEngineWindow(const std::string& profile, bool own_window,
                                                                       const std::vector<std::string>& windows) {
  const std::optional<engine::Guid> profile_id = ParseGuid(profile);
  if (!profile_id) return std::nullopt;
  std::vector<engine::Guid> stacked;
  for (const std::string& window : windows) {
    if (const std::optional<engine::Guid> id = ParseGuid(window)) stacked.push_back(*id);
  }
  engine::WireWriter writer;
  writer.WriteVarint(CREST_QUERY_ENGINE_WINDOW_PLACEMENT);
  engine::Write(writer, *profile_id);
  engine::Write(writer, own_window);
  engine::Write(writer, stacked);
  std::vector<uint8_t> answer;
  if (Query(writer.bytes(), answer) != CREST_OK) return std::nullopt;
  engine::WireReader reader(answer.data(), answer.size());
  std::optional<engine::Guid> window;
  std::optional<engine::Guid> space;
  bool opens_window = false;
  engine::Read(reader, window);
  engine::Read(reader, space);
  engine::Read(reader, opens_window);
  if (!reader.ok() || !reader.AtEnd() || !window || !space) return std::nullopt;
  return EngineWindowPlace{.window = GuidText(*window), .space = GuidText(*space), .opens_window = opens_window};
}

crest_status_t CoreHost::PageRequest(base::span<const uint8_t> request, std::vector<uint8_t>& out) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const crest_engine_pages_t pages = EngineBinding::Get().Pages();
  crest_buffer_t buffer = {nullptr, 0};
  const crest_status_t status = pages.request(pages.context, request.data(), request.size(), &buffer);
  out = Bytes(buffer);
  pages.release(pages.context, &buffer);
  return status;
}

void CoreHost::Shutdown() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (shut_down_) return;
  shut_down_ = true;
  library_->set_wake(app_, nullptr, nullptr);
  const crest_engine_pages_t pages = EngineBinding::Get().Pages();
  pages.present_to(pages.context, nullptr, nullptr);
  library_->engine_unregister(app_, engine_);
  library_->destroy(app_);
}

// static
void CREST_CALL CoreHost::Wake(void* context) {
  if (g_drain_queued.exchange(true)) return;
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&CoreHost::Drain, static_cast<CoreHost*>(context)->weak_factory_.GetWeakPtr()));
}

// static
void CREST_CALL CoreHost::Present(void* ui, const uint8_t* presentation, size_t length) {
  auto* host = static_cast<CoreHost*>(ui);
  const base::span<const uint8_t> bytes(presentation, length);
  for (Observer& observer : host->observers_) observer.OnPresentation(bytes);
}

void CoreHost::Drain() {
  g_drain_queued = false;
  if (shut_down_) return;
  crest_buffer_t buffer = {nullptr, 0};
  const crest_status_t status = library_->drain(app_, &buffer);
  std::vector<uint8_t> changes = library_->Take(buffer);
  if (status == CREST_OK) Publish(std::move(changes));
  library_->end_turn(app_);
}

void CoreHost::Publish(std::vector<uint8_t> changes) {
  // An empty batch is a count of zero.
  if (changes.empty() || (changes.size() == 1 && changes[0] == 0)) return;
  history_.push_back(changes);
  for (Observer& observer : observers_) observer.OnChanges(history_.back());
}

}  // namespace crest
