// Harness stand-in for xenia/base/logging.h: no logging, strip_pii from the
// harness.
#pragma once
#include <string>
#include <string_view>
namespace xe {
std::string strip_pii(const std::string_view text);
}  // namespace xe
#define XELOGI(...) ((void)0)
#define XELOGW(...) ((void)0)
#define XELOGE(...) ((void)0)
