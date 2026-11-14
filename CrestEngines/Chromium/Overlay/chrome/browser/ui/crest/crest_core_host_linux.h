#ifndef CHROME_BROWSER_UI_CREST_CREST_CORE_HOST_LINUX_H_
#define CHROME_BROWSER_UI_CREST_CREST_CORE_HOST_LINUX_H_

// Crest's core inside the Linux browser process. On the Mac, Crest's Swift UI
// creates the core and registers the engine binding with it. On Linux the UI
// is drawn by Chromium itself, so the browser process creates the core: it
// loads CrestCore.Native.so, opens the app over the Crest profile's storage,
// registers the binding, and answers the core's wake on the UI thread. Crest's
// WebUI reaches the core through this host, in the core's own wire format.

#include <cstdint>
#include <string>
#include <vector>

#include "base/containers/span.h"
#include "base/files/file_path.h"
#include "base/memory/weak_ptr.h"
#include "base/observer_list.h"
#include "base/observer_list_types.h"
#include "chrome/browser/ui/crest/crest_app.h"

namespace crest {

class CoreHost {
 public:
  // What the core published, in the order it published it.
  class Observer : public base::CheckedObserver {
   public:
    // One encoded batch of changes: a count, then each change.
    virtual void OnChanges(base::span<const uint8_t> changes) = 0;
    // One encoded EnginePresentation for a page.
    virtual void OnPresentation(base::span<const uint8_t> presentation) = 0;
  };

  // The started host, or null before Start succeeds.
  static CoreHost* Get();
  // Loads the core and opens its app over `storage`, then registers the
  // engine binding. False with `error` set when the core cannot start.
  static bool Start(const base::FilePath& storage, std::string* error);

  CoreHost(const CoreHost&) = delete;
  CoreHost& operator=(const CoreHost&) = delete;

  // crest_app_dispatch, crest_app_query and the binding's PageRequest. `out`
  // holds the answer, the changes or one rejection, as the status says. The
  // changes a dispatch published also reach the observers.
  crest_status_t Dispatch(base::span<const uint8_t> intent, std::vector<uint8_t>& out);
  crest_status_t Query(base::span<const uint8_t> query, std::vector<uint8_t>& out);
  crest_status_t PageRequest(base::span<const uint8_t> request, std::vector<uint8_t>& out);

  // Every batch of changes since the core started, oldest first. A UI that
  // starts late replays them to reach the state the core holds.
  const std::vector<std::vector<uint8_t>>& history() const { return history_; }

  void AddObserver(Observer* observer) { observers_.AddObserver(observer); }
  void RemoveObserver(Observer* observer) { observers_.RemoveObserver(observer); }

  // Saves, unregisters the binding and closes the core's session file.
  void Shutdown();

 private:
  struct Library;

  CoreHost(std::unique_ptr<Library> library, uint64_t app);
  ~CoreHost();

  static void CREST_CALL Wake(void* context);
  static void CREST_CALL Present(void* ui, const uint8_t* presentation, size_t length);
  void Drain();
  void Publish(std::vector<uint8_t> changes);

  std::unique_ptr<Library> library_;
  uint64_t app_ = 0;
  uint64_t engine_ = 0;
  bool shut_down_ = false;
  std::vector<std::vector<uint8_t>> history_;
  base::ObserverList<Observer> observers_;
  base::WeakPtrFactory<CoreHost> weak_factory_{this};
};

}  // namespace crest

#endif  // CHROME_BROWSER_UI_CREST_CREST_CORE_HOST_LINUX_H_
