// Harness stand-in for xenia/base/exception_handler.h: the observer slot only.
#pragma once
#include <cstdint>
namespace xe {
struct HostThreadContext {
  uint64_t x[31];
  uint64_t sp;
  uint64_t pc;
  uint64_t pstate;
};
class ExceptionHandler {
 public:
  typedef void (*UnhandledObserver)(int signal_number, uint64_t fault_address,
                                    const HostThreadContext* context);
  static void SetUnhandledObserver(UnhandledObserver observer);
};
}  // namespace xe
