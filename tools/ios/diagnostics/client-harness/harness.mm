// Runs the app's diagnostics client code (outbox, session stats, fault record,
// switches) on the Mac against the local Worker (../dev/server.mjs), with the
// xenia internals it touches replaced by ./shim. Built and run by run.sh,
// which gives it a throwaway home directory.

#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonHMAC.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <unistd.h>

#include <cstdlib>
#include <string>

#include "xenia/base/exception_handler.h"
#include "xenia/base/logging.h"
#include "xenia/gpu/gpu_flags.h"
#include "xenia/gpu/metal/metal_compile_activity.h"
#import "xenia/ui/ios/shared/ios_crash_context.h"
#import "xenia/ui/ios/shared/ios_diagnostics_outbox.h"
#import "xenia/ui/ios/shared/ios_fault_record.h"
#import "xenia/ui/ios/shared/ios_online_features.h"
#import "xenia/ui/ios/shared/ios_session_stats.h"

extern "C" xe_ios_crash_context_t xe_ios_crash_context;

// ---- Stand-ins for what the shims declare

static xe::ExceptionHandler::UnhandledObserver g_observer = nullptr;
void xe::ExceptionHandler::SetUnhandledObserver(UnhandledObserver observer) {
  g_observer = observer;
}

std::string xe::strip_pii(const std::string_view text) {
  std::string out(text);
  const std::string home = NSHomeDirectory().UTF8String;
  for (size_t at; (at = out.find(home)) != std::string::npos;) {
    out.replace(at, home.size(), "~");
  }
  return out;
}

NSString* xe_ios_diagnostics_launch_id(void) { return @"7E57AAAA-0000-4000-8000-000000000001"; }

static NSString* Base64URL(NSData* data) {
  NSString* s = [data base64EncodedStringWithOptions:0];
  s = [s stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
  s = [s stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  return [s stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

NSDictionary* xe_current_compat_report_build_info(void) {
  NSMutableDictionary* info = [@{
    @"buildId" : @"ios-harness-0.0.0-0",
    @"channel" : @"release",
    @"official" : @YES,
    @"appVersion" : @"0.0.0",
    @"buildNumber" : @"0",
    @"commitShort" : @"harness",
  } mutableCopy];
  const char* key = getenv("XENIOS_TEST_ATTESTATION_KEY");
  if (key && *key) {
    NSString* payload =
        @"xenios-build-attestation-v1;platform=ios;channel=release;buildId=ios-harness-0.0.0-0";
    unsigned char mac[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, key, strlen(key), payload.UTF8String, strlen(payload.UTF8String), mac);
    info[@"attestation"] = @{
      @"payload" : payload,
      @"signature" : Base64URL([NSData dataWithBytes:mac length:sizeof(mac)]),
    };
  }
  return info;
}

// ---- Checks

static int g_failures = 0;

static void Check(bool ok, NSString* what) {
  printf("%s %s\n", ok ? "PASS" : "FAIL", what.UTF8String);
  if (!ok) {
    ++g_failures;
  }
}

static NSArray<NSString*>* WaitForPending(NSUInteger count, double seconds) {
  NSArray<NSString*>* pending = nil;
  for (double waited = 0; waited < seconds; waited += 0.1) {
    pending = xe_ios_diagnostics_pending_reports();
    if (pending.count == count) {
      break;
    }
    usleep(100000);
  }
  return pending;
}

__attribute__((noinline)) static void ImageFunction() { asm volatile(""); }

static void TestFaultRecord() {
  Check(xe_ios_fault_record_take_previous() == nil, @"fault: nothing recorded at first");
  xe_ios_fault_record_install(xe_ios_diagnostics_launch_id(), @"http://127.0.0.1:8788/v1/diag",
                              [@"{\"build\":{}}" dataUsingEncoding:NSUTF8StringEncoding]);
  Check(g_observer != nullptr, @"fault: observer registered with the exception handler");
  xe_ios_fault_record_note_title(0x4D5307E6);
  static uint8_t jit[4096];
  xe_ios_fault_record_note_jit_range(reinterpret_cast<uint64_t>(jit), sizeof(jit));

  // A frame-pointer chain: image -> JIT -> end, in increasing addresses.
  const uint64_t image_address = reinterpret_cast<uint64_t>(&ImageFunction) + 8;
  uint64_t* chain = static_cast<uint64_t*>(calloc(8, sizeof(uint64_t)));
  chain[0] = reinterpret_cast<uint64_t>(&chain[2]);
  chain[1] = image_address + 4;
  chain[2] = reinterpret_cast<uint64_t>(&chain[4]);
  chain[3] = reinterpret_cast<uint64_t>(jit) + 0x40;
  chain[4] = 0;
  chain[5] = 0;
  xe::HostThreadContext context = {};
  context.pc = reinterpret_cast<uint64_t>(jit) + 0x10;
  context.x[30] = image_address;
  context.x[29] = reinterpret_cast<uint64_t>(chain);
  g_observer(SIGSEGV, 0x10, &context);
  g_observer(SIGBUS, 0x20, &context);  // A second fault is ignored.

  Check(xe_ios_crash_context.fault_signal == SIGSEGV, @"fault: crash context has the signal");
  Check(xe_ios_crash_context.fault_frame_count == 2, @"fault: crash context has 2 walked frames");
  Check(!strcmp(xe_ios_crash_context.launch_id, xe_ios_diagnostics_launch_id().UTF8String),
        @"fault: crash context has the launch ID");

  NSDictionary* record = xe_ios_fault_record_take_previous();
  NSArray* frames = record[@"frames"];
  NSLog(@"fault record: %@", record);
  Check([record[@"signal"] isEqual:@"SIGSEGV"], @"fault: record signal SIGSEGV");
  Check([record[@"titleId"] isEqual:@"4D5307E6"], @"fault: record title ID");
  Check([record[@"inJit"] boolValue], @"fault: pc in the JIT");
  Check([record[@"launchId"] isEqual:xe_ios_diagnostics_launch_id()], @"fault: record launch ID");
  Check([record[@"binaryUUID"] isEqual:xe_ios_fault_record_binary_uuid()],
        @"fault: record binary UUID");
  Check(frames.count == 4, @"fault: pc, lr and two walked frames");
  Check([frames[0][@"image"] isEqual:@"<jit>"] && [frames[0][@"offset"] isEqual:@"0x10"],
        @"fault: frame 0 is JIT+0x10");
  Check([frames[1][@"image"] isEqual:@"XeniOS"], @"fault: frame 1 (lr) is in the image");
  Check([frames[3][@"image"] isEqual:@"<jit>"] && [frames[3][@"offset"] isEqual:@"0x40"],
        @"fault: frame 3 is JIT+0x40");
  Check(xe_ios_fault_record_take_previous() == nil, @"fault: the record is taken once");
  free(chain);
}

// Spins rather than sleeps: launched from a background shell, the harness's
// sleeps wake several ms late.
static void SpinMs(double ms) {
  mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  const uint64_t end =
      mach_absolute_time() + uint64_t(ms * 1e6 * timebase.denom / timebase.numer);
  while (mach_absolute_time() < end) {
  }
}

static void TestSessionStats() {
  // Uncapped at the first sample (5 to 6 s in: the timer has 1 s of leeway),
  // capped at the end.
  cvars::guest_display_refresh_cap = false;
  cvars::framerate_limit = 60;
  xe::gpu::metal::CompileActivity& activity = xe::gpu::metal::compile_activity;
  xe::gpu::metal::command_buffer_failures.fetch_add(3);
  xe_ios_session_stats_begin();
  xe_ios_session_stats_note_title(0x4D5307E6);
  NSMutableDictionary* unfinished = xe_ios_session_stats_take_unfinished();
  Check([unfinished[@"end"] isEqual:@"unfinished"], @"stats: checkpoint written at the start");
  Check([unfinished[@"launchId"] isEqual:xe_ios_diagnostics_launch_id()],
        @"stats: the checkpoint keeps the launch for a crash record");
  usleep(50000);
  // The game's stored pipelines start loading.
  activity.storage_total.store(1200);
  activity.storage_generation.fetch_add(1);
  for (int i = 0; i < 20; ++i) {
    xe_ios_session_stats_note_guest_frame();
    SpinMs(16.5);
  }
  // A long frame while a shader compile is queued.
  activity.queued.fetch_add(1);
  usleep(60000);
  xe_ios_session_stats_note_guest_frame();
  activity.finished.fetch_add(1);
  xe::gpu::metal::command_buffer_failures.fetch_add(2);
  // A pause, not a frame, past the first sample.
  usleep(6200000);
  cvars::guest_display_refresh_cap = true;
  usleep(500000);
  xe_ios_session_stats_note_guest_frame();
  NSDictionary* record = xe_ios_session_stats_end();
  NSLog(@"session record: %@", record);
  NSArray<NSNumber*>* counts = record[@"counts"];
  unsigned total = 0;
  for (NSNumber* n in counts) {
    total += n.unsignedIntValue;
  }
  Check(counts.count == 13, @"stats: 13 buckets");
  Check(total == [record[@"frames"] unsignedIntValue] && total == 20,
        @"stats: 20 frames counted, the first and the pause not");
  Check(counts[0].intValue == 0 && counts[1].intValue == 0 && counts[2].intValue >= 18,
        @"stats: 16.5 ms frames land in the 60 fps band");
  Check([record[@"firstFrameMs"] intValue] >= 50 && [record[@"firstFrameMs"] intValue] < 1000,
        @"stats: time to the first frame");
  Check([record[@"pipelinesCompiled"] intValue] == 1, @"stats: one pipeline compiled");
  Check([record[@"storedPipelines"] intValue] == 1200, @"stats: stored pipelines");
  Check([record[@"gpuErrors"] intValue] == 2, @"stats: GPU errors during the session only");
  Check(record[@"launchId"] == nil && record[@"cpuS"] == nil, @"stats: no launch ID or CPU time");
  Check([record[@"gaps"] intValue] == 1, @"stats: one gap");
  Check([record[@"longFrames"] intValue] == 1, @"stats: one long frame");
  Check([record[@"longFramesDuringShaderCompile"] intValue] == 1,
        @"stats: the long frame overlapped a compile");
  Check([record[@"titleId"] isEqual:@"4D5307E6"], @"stats: title ID");
  Check([record[@"end"] isEqual:@"normal"], @"stats: normal end");
  Check([record[@"guestRefreshCap"] isEqual:@"mixed"], @"stats: refresh cap changed mid-session");
  Check([record[@"framerateLimit"] intValue] == 60, @"stats: frame rate limit");
  cvars::framerate_limit = 0;
  Check([record[@"durationS"] intValue] >= 2, @"stats: duration");
  Check(xe_ios_session_stats_end() == nil, @"stats: ending twice is a no-op");
  Check(xe_ios_session_stats_take_unfinished() == nil, @"stats: no checkpoint after a normal end");
}

static void TestOutbox(NSString* good_url) {
  NSUserDefaults* defaults = [NSUserDefaults standardUserDefaults];
  xe_ios_diagnostics_clear_outbox();
  Check(WaitForPending(0, 2).count == 0, @"outbox: empty");

  NSString* home = NSHomeDirectory();
  NSDictionary* body = @{
    @"titleId" : @"4D5307E6",
    @"message" : [home stringByAppendingString:@"/Documents/Kenji's Halo 3.iso: not found"],
    @"vm" : @"/private/var/mobile/Containers/Data/Application/ABC/Documents/a b.xex",
    @"mail" : @"write to someone@example.com",
    @"mac" : @"/Users/kenji/Games/Gears 2/default.xex: bad header",
    @"bare" : @"Failed to open Gears2.iso",
    @"quoted" : @"Profile \"Kenji\" not found, can't sign in",
    @"symbol" : @"xe::kernel::XThread::Execute()",
  };
  xe_ios_diagnostics_enqueue(@"crash", body);
  NSArray<NSString*>* pending = WaitForPending(1, 2);
  Check(pending.count == 1, @"outbox: one record queued");
  NSString* text = pending.firstObject;
  Check(![text containsString:@"Kenji"] && ![text containsString:@"Halo"] &&
            [text containsString:@"~/Documents/<file>: not found"],
        @"outbox: document file name redacted");
  Check([text containsString:@"\"vm\" : \"<path>\""], @"outbox: device path redacted");
  Check(![text containsString:@"someone@"] && [text containsString:@"<email>"],
        @"outbox: e-mail redacted");
  Check([text containsString:@"\"mac\" : \"<path>: bad header\""], @"outbox: Mac path redacted");
  Check([text containsString:@"Failed to open <file>"], @"outbox: game file name redacted");
  Check([text containsString:@"Profile \\\"<text>\\\" not found, can't sign in"],
        @"outbox: quoted name redacted, apostrophes kept");
  Check([text containsString:@"xe::kernel::XThread::Execute()"], @"outbox: symbols kept");
  Check(![text containsString:@"createdAt"] && ![text containsString:@"lowPower"],
        @"outbox: no timestamp or Low Power flag");
  Check([text containsString:@"\"model\""] && [text containsString:@"\"binaryUUID\""] &&
            [text containsString:@"\"schema\" : 1"],
        @"outbox: envelope fields present");
  printf("--- pending record as shown in Settings ---\n%s\n---\n", text.UTF8String);

  // No server: kept, and retried later.
  [defaults setObject:@"http://127.0.0.1:1/v1/diag" forKey:@"XeniaDiagnosticsURL"];
  xe_ios_diagnostics_upload_pending();
  sleep(2);
  Check(xe_ios_diagnostics_pending_reports().count == 1, @"upload: kept after a network error");
  Check([[defaults objectForKey:@"XeniaDiagnosticsRetryAfter"] timeIntervalSinceNow] > 600,
        @"upload: backing off 15 minutes");
  // Something else answering (a proxy, a captive portal): kept too.
  [defaults removeObjectForKey:@"XeniaDiagnosticsRetryAfter"];
  [defaults setObject:[good_url stringByReplacingOccurrencesOfString:@"/v1/diag"
                                                          withString:@"/v1/elsewhere"]
               forKey:@"XeniaDiagnosticsURL"];
  xe_ios_diagnostics_upload_pending();
  sleep(2);
  Check(xe_ios_diagnostics_pending_reports().count == 1, @"upload: kept after a 404");
  [defaults setObject:good_url forKey:@"XeniaDiagnosticsURL"];
  xe_ios_diagnostics_upload_pending();
  sleep(1);
  Check(xe_ios_diagnostics_pending_reports().count == 1, @"upload: waits out the backoff");

  // The server: accepted and deleted, then a session record too.
  [defaults removeObjectForKey:@"XeniaDiagnosticsRetryAfter"];
  xe_ios_diagnostics_enqueue(@"session", @{
    @"titleId" : @"4D5307E6",
    @"durationS" : @60,
    @"frames" : @3000,
    @"intervalMs" :
        @[ @10, @15, @18.33, @25, @30, @36.67, @45, @55, @60, @73.33, @100, @250 ],
    @"counts" : @[ @0, @0, @2900, @50, @20, @10, @5, @5, @5, @2, @1, @1, @1 ],
    @"end" : @"normal",
  });
  WaitForPending(2, 2);
  xe_ios_diagnostics_upload_pending();
  Check(WaitForPending(0, 10).count == 0, @"upload: both records accepted and deleted");
  Check([defaults objectForKey:@"XeniaDiagnosticsRetryDelay"] == nil, @"upload: backoff reset");

  // Nothing is queued while a game runs or once sharing is off.
  xe_ios_session_stats_begin();
  xe_ios_diagnostics_enqueue(@"session", @{@"durationS" : @1});
  WaitForPending(1, 2);
  xe_ios_diagnostics_upload_pending();
  sleep(1);
  Check(xe_ios_diagnostics_pending_reports().count == 1, @"upload: nothing sent while a game runs");
  xe_ios_session_stats_end();
  xe_ios_set_share_diagnostics_enabled(NO);
  Check(!xe_ios_diagnostics_upload_allowed(), @"switch: off stops diagnostics");
  xe_ios_diagnostics_clear_outbox();
  xe_ios_diagnostics_enqueue(@"session", @{@"durationS" : @1});
  Check(WaitForPending(0, 2).count == 0, @"switch: nothing queued while off");
  xe_ios_set_share_diagnostics_enabled(YES);
}

static void TestSwitches() {
  NSUserDefaults* defaults = [NSUserDefaults standardUserDefaults];
  for (NSString* key in @[ @"XeniaOnlineFeaturesEnabled", @"XeniaOnlineFeaturesNoticeRevision",
                           @"XeniaShareDiagnosticsEnabled", @"XeniaDiagnosticsNoticeAnswered" ]) {
    [defaults removeObjectForKey:key];
  }
  Check(!xe_ios_diagnostics_upload_allowed(), @"switch: off before the first-launch notice");
  NSString* url = [defaults stringForKey:@"XeniaDiagnosticsURL"];
  [defaults removeObjectForKey:@"XeniaDiagnosticsURL"];
  xe_ios_set_online_features_notice_answered();
  Check(!xe_ios_diagnostics_available() && !xe_ios_diagnostics_upload_allowed(),
        @"switch: off in a build without an endpoint");
  Check(!xe_ios_diagnostics_notice_pending(),
        @"switch: no one-time notice in a build without an endpoint");
  [defaults setObject:url forKey:@"XeniaDiagnosticsURL"];
  Check(xe_ios_diagnostics_available(), @"switch: available with an endpoint");
  // Its first-launch notice didn't mention diagnostics, so a build with them asks once.
  Check(xe_ios_diagnostics_notice_pending() && !xe_ios_diagnostics_upload_allowed(),
        @"switch: a build with an endpoint asks after a notice answered without one");
  [defaults removeObjectForKey:@"XeniaOnlineFeaturesNoticeRevision"];
  [defaults removeObjectForKey:@"XeniaDiagnosticsNoticeAnswered"];
  Check(!xe_ios_diagnostics_notice_pending(), @"switch: new install gets no one-time notice");
  xe_ios_set_online_features_notice_answered();
  Check(xe_ios_diagnostics_upload_allowed(), @"switch: on by default after the notice");
  // An install that answered the notice before it covered diagnostics.
  [defaults removeObjectForKey:@"XeniaDiagnosticsNoticeAnswered"];
  xe_ios_set_online_features_enabled(NO);
  Check(!xe_ios_diagnostics_notice_pending(),
        @"switch: no one-time notice while Online Features is off");
  xe_ios_set_online_features_enabled(YES);
  Check(xe_ios_diagnostics_notice_pending(), @"switch: existing install gets the one-time notice");
  Check(!xe_ios_diagnostics_upload_allowed(), @"switch: off until it is answered");
  xe_ios_set_diagnostics_notice_answered();
  Check(xe_ios_diagnostics_upload_allowed(), @"switch: on once answered");
  xe_ios_set_online_features_enabled(NO);
  Check(!xe_ios_diagnostics_upload_allowed(), @"switch: Online Features off stops diagnostics");
  xe_ios_set_online_features_enabled(YES);
  // Declining diagnostics alone ("Don't Send Diagnostics", Share Diagnostics off).
  xe_ios_set_share_diagnostics_enabled(NO);
  Check(!xe_ios_diagnostics_upload_allowed() && xe_ios_online_features_enabled(),
        @"switch: Share Diagnostics off leaves Online Features on");
  xe_ios_set_share_diagnostics_enabled(YES);
}

int main(int argc, const char** argv) {
  @autoreleasepool {
    const char* fixed_home = getenv("CFFIXED_USER_HOME");
    if (!fixed_home || ![NSHomeDirectory() isEqualToString:@(fixed_home)] || argc < 2) {
      fprintf(stderr, "usage: CFFIXED_USER_HOME=DIR harness ENDPOINT_URL\n");
      return 2;
    }
    [[NSUserDefaults standardUserDefaults] setObject:@(argv[1]) forKey:@"XeniaDiagnosticsURL"];
    TestSwitches();
    TestFaultRecord();
    TestSessionStats();
    TestOutbox(@(argv[1]));
    printf("%s: %d failure(s)\n", g_failures ? "FAILED" : "ALL PASSED", g_failures);
    return g_failures ? 1 : 0;
  }
}
