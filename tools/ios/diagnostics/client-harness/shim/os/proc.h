// Harness stand-in: os_proc_available_memory is iOS-only.
#pragma once
#include <stddef.h>
static inline size_t os_proc_available_memory(void) { return (size_t)3 << 30; }
