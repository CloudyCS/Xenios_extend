// Harness stand-in for xenia/gpu/gpu_flags.h: the display settings the session
// statistics record.
#pragma once
#include <cstdint>
namespace cvars {
inline bool guest_display_refresh_cap = true;
inline uint32_t framerate_limit = 0;
}  // namespace cvars
